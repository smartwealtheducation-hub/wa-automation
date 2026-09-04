// Generates and uploads images via Pollinations.ai using an authenticated
// Secret Key (POLLINATIONS_API_KEY, free to create at enter.pollinations.ai).
// Uses the "flux" model.
//
// IMPORTANT: the AI background prompt never asks for any text, icons, or
// buttons to be drawn - AI image models cannot reliably spell arbitrary
// text (even paid ones struggle with this), so every piece of text in the
// thumbnail (headline, icon labels, CTA button) is drawn separately in code
// with a real font via sharp/SVG, guaranteeing correct spelling every time.
// The AI only supplies the photo/background mood behind it.
//
// Layout uses a running vertical cursor (not fixed % positions) so it
// adapts cleanly whether the headline wraps to 2 lines or 4, and the icon
// badges/CTA button are always placed with guaranteed clearance below
// whatever the headline actually needed, instead of overlapping it.
//
// Each image makes ONE WordPress API call (alt_text passed as a query param
// on the same upload request). Includes automatic retries with backoff for
// transient errors (429, 500-504) on both image generation and WordPress calls.
import sharp from "sharp";

const { WP_SITE_URL, WP_USERNAME, WP_APP_PASSWORD, POLLINATIONS_API_KEY } =
  process.env;

const MAX_RETRIES = 4;
const RETRY_STATUS_CODES = [429, 500, 502, 503, 504];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, label) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) return res;

    const errText = await res.text();
    lastError = new Error(`${label} failed ${res.status}: ${errText}`);

    const shouldRetry =
      RETRY_STATUS_CODES.includes(res.status) && attempt < MAX_RETRIES;
    if (!shouldRetry) throw lastError;

    const waitMs = attempt * 30000;
    console.log(
      `${label} returned ${res.status} (attempt ${attempt}/${MAX_RETRIES}) - retrying in ${waitMs / 1000}s...`
    );
    await sleep(waitMs);
  }
  throw lastError;
}

async function generateImage(prompt, width = 1024, height = 1024) {
  // A random seed each call prevents the model from converging on
  // near-identical results for similarly-worded prompts across articles.
  const seed = Math.floor(Math.random() * 2147483647);
  const encoded = encodeURIComponent(prompt);
  const url = `https://gen.pollinations.ai/image/${encoded}?width=${width}&height=${height}&nologo=true&model=flux&seed=${seed}`;
  const res = await fetchWithRetry(
    url,
    { headers: { Authorization: `Bearer ${POLLINATIONS_API_KEY}` } },
    "Image generation"
  );
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function uploadImageToWordPress(imageBuffer, filename, altText) {
  const auth = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString(
    "base64"
  );
  const url = `${WP_SITE_URL}/wp-json/wp/v2/media?alt_text=${encodeURIComponent(altText)}`;
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
      body: imageBuffer,
    },
    "WordPress media upload"
  );
  const media = await res.json();
  return { id: media.id, url: media.source_url };
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60);
}

function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapText(text, maxCharsPerLine) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (test.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function shortenLabel(text, maxChars = 16) {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > 6 ? truncated.slice(0, lastSpace) : truncated;
  return `${cut}...`;
}

const ICON_PATHS = [
  "M -10 0 L -3 8 L 12 -10", // checkmark
  "M 0 -14 L 4 -4 L 14 0 L 4 4 L 0 14 L -4 4 L -14 0 L -4 -4 Z", // star
  "M -4 -14 L 8 -2 L 0 -2 L 4 14 L -10 0 L -2 0 Z", // lightning bolt
];

function iconBadgeSvg(cx, cy, radius, iconIndex, label, accentColor) {
  const path = ICON_PATHS[iconIndex % ICON_PATHS.length];
  const shortLabel = shortenLabel(label, 14);
  return `
    <g transform="translate(${cx}, ${cy})">
      <circle r="${radius}" fill="none" stroke="${accentColor}" stroke-width="3" />
      <g stroke="${accentColor}" stroke-width="3" fill="none"
         stroke-linecap="round" stroke-linejoin="round"
         transform="scale(${radius / 22})">
        <path d="${path}" />
      </g>
      <text x="0" y="${radius + 22}" font-family="Arial, Helvetica, sans-serif"
        font-weight="700" font-size="13" fill="white" text-anchor="middle">${escapeXml(shortLabel)}</text>
    </g>
  `;
}

// Builds the full "poster style" overlay using a running vertical cursor,
// so badges and the CTA button are always placed with real clearance below
// however many lines the headline actually needed - never overlapping.
async function addPosterOverlay(imageBuffer, title, badgeLabels, ctaText) {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width;
  const height = metadata.height;
  const accentColor = "#f5b942";

  const roughWrap = wrapText(title.toUpperCase(), 16);
  const lineCount = Math.min(roughWrap.length, 4);
  const fontSize =
    lineCount <= 2
      ? Math.round(height * 0.13)
      : lineCount === 3
      ? Math.round(height * 0.105)
      : Math.round(height * 0.088);
  const maxCharsPerLine = Math.round(16 * (Math.round(height * 0.13) / fontSize));
  const lines = wrapText(title.toUpperCase(), maxCharsPerLine).slice(0, 4);

  const lineHeight = Math.round(fontSize * 1.08);
  const startX = Math.round(width * 0.05);
  let cursorY = Math.round(height * 0.16) + fontSize;

  const headlineSvg = lines
    .map((line, i) => {
      const color = i === lines.length - 1 ? accentColor : "white";
      const y = cursorY + i * lineHeight;
      return `<text x="${startX}" y="${y}" font-family="Arial, Helvetica, sans-serif"
        font-weight="900" font-size="${fontSize}" fill="${color}"
        text-anchor="start">${escapeXml(line)}</text>`;
    })
    .join("\n");

  cursorY = cursorY + (lines.length - 1) * lineHeight;
  cursorY += Math.round(height * 0.11);

  const badgeRadius = Math.round(height * 0.055);
  const badgeCenterY = cursorY;
  const badgeSpacing = Math.round(width * 0.21);
  const badgesSvg = badgeLabels
    .slice(0, 3)
    .map((label, i) =>
      iconBadgeSvg(
        startX + badgeRadius + i * badgeSpacing,
        badgeCenterY,
        badgeRadius,
        i,
        label,
        accentColor
      )
    )
    .join("\n");

  cursorY = badgeCenterY + badgeRadius + 24;
  cursorY += Math.round(height * 0.06);

  const btnWidth = Math.round(width * 0.24);
  const btnHeight = Math.round(height * 0.1);
  const btnX = startX;
  const btnY = Math.min(cursorY, height - btnHeight - Math.round(height * 0.04));
  const ctaSvg = `
    <rect x="${btnX}" y="${btnY}" width="${btnWidth}" height="${btnHeight}"
      rx="${Math.round(btnHeight * 0.15)}" fill="${accentColor}" />
    <text x="${btnX + btnWidth / 2}" y="${btnY + btnHeight / 2 + Math.round(btnHeight * 0.12)}"
      font-family="Arial, Helvetica, sans-serif" font-weight="800"
      font-size="${Math.round(btnHeight * 0.32)}" fill="#101828"
      text-anchor="middle">${escapeXml(ctaText)}</text>
  `;

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="wash" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="black" stop-opacity="0.78" />
          <stop offset="55%" stop-color="black" stop-opacity="0.55" />
          <stop offset="75%" stop-color="black" stop-opacity="0" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${width}" height="${height}" fill="url(#wash)" />
      ${headlineSvg}
      ${badgesSvg}
      ${ctaSvg}
    </svg>
  `;

  return sharp(imageBuffer)
    .resize(width, height)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

const BACKGROUND_STYLE = `Photorealistic professional photography, cinematic
lighting, high quality advertising photograph. Absolutely no text, letters,
numbers, words, icons, buttons, or graphic overlays anywhere in the image -
just the photographic scene itself.`;

// Several distinct scene/setting variations so consecutive articles don't
// all converge on the same generic "person at a laptop" look.
const SCENE_VARIATIONS = [
  "A young professional person thoughtfully working at a laptop in a dark navy studio setting",
  "A confident entrepreneur reviewing notes at a modern minimalist desk near a window",
  "A focused professional typing on a laptop in a warmly lit home office",
  "A person sketching ideas on a notepad next to an open laptop in a bright co-working space",
  "A professional standing and thinking with arms crossed in front of a large monitor showing charts",
];

export async function createArticleImage(title, topic, badgeLabels) {
  const scene = SCENE_VARIATIONS[Math.floor(Math.random() * SCENE_VARIATIONS.length)];
  const prompt = `${scene}, representing: ${topic}. ${BACKGROUND_STYLE}`;
  const rawImage = await generateImage(prompt, 1200, 628);
  const withOverlay = await addPosterOverlay(
    rawImage,
    title,
    badgeLabels || [],
    "READ MORE"
  );
  const filename = `${slugify(title)}-thumbnail.png`;
  return await uploadImageToWordPress(withOverlay, filename, title);
}

export async function createInlineImage(title, prompt, index) {
  const fullPrompt = `A flat vector illustration for a blog article. Scene:
${prompt}. Style: flat vector illustration, minimalist icon-style design,
bold flat colors, simple geometric shapes, clean crisp lines, high contrast.
Absolutely no text, letters, numbers, or words anywhere in the image. No
photorealism, no people's faces close-up, no logos.`;
  const imageBuffer = await generateImage(fullPrompt, 1024, 683);
  const filename = `${slugify(title)}-inline-${index}.png`;
  return await uploadImageToWordPress(imageBuffer, filename, prompt);
}
