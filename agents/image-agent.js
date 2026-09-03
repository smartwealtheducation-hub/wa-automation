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
  const encoded = encodeURIComponent(prompt);
  const url = `https://gen.pollinations.ai/image/${encoded}?width=${width}&height=${height}&nologo=true&model=flux`;
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

// Three simple, universally-recognizable icon glyphs drawn as raw SVG paths
// (no icon font/library needed, so they always render reliably). Cycled
// through for the 3 badge labels.
const ICON_PATHS = [
  // checkmark
  "M -10 0 L -3 8 L 12 -10",
  // star (simple 4-point)
  "M 0 -14 L 4 -4 L 14 0 L 4 4 L 0 14 L -4 4 L -14 0 L -4 -4 Z",
  // lightning bolt
  "M -4 -14 L 8 -2 L 0 -2 L 4 14 L -10 0 L -2 0 Z",
];

function iconBadgeSvg(cx, cy, radius, iconIndex, label, accentColor) {
  const path = ICON_PATHS[iconIndex % ICON_PATHS.length];
  return `
    <g transform="translate(${cx}, ${cy})">
      <circle r="${radius}" fill="none" stroke="${accentColor}" stroke-width="3" />
      <g stroke="${accentColor}" stroke-width="3" fill="none"
         stroke-linecap="round" stroke-linejoin="round"
         transform="scale(${radius / 22})">
        <path d="${path}" />
      </g>
      <text x="0" y="${radius + 26}" font-family="Arial, Helvetica, sans-serif"
        font-weight="700" font-size="20" fill="white" text-anchor="middle">${escapeXml(label)}</text>
    </g>
  `;
}

// Builds the full "poster style" overlay: a left-aligned two-tone bold
// headline, 3 icon badges with real (correctly spelled) labels, and a
// filled CTA button with real text - all drawn in code, not by the AI.
async function addPosterOverlay(imageBuffer, title, badgeLabels, ctaText) {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width;
  const height = metadata.height;
  const accentColor = "#f5b942"; // gold accent, matches the reference style

  // Headline: wrap into lines, make the FINAL line gold, others white -
  // gives the same two-tone emphasis effect as the reference image.
  const lines = wrapText(title.toUpperCase(), 16).slice(0, 3);
  const fontSize = Math.round(height * 0.13);
  const lineHeight = Math.round(fontSize * 1.05);
  const startX = Math.round(width * 0.05);
  const startY = Math.round(height * 0.22);

  const headlineSvg = lines
    .map((line, i) => {
      const color = i === lines.length - 1 ? accentColor : "white";
      const y = startY + i * lineHeight;
      return `<text x="${startX}" y="${y}" font-family="Arial, Helvetica, sans-serif"
        font-weight="900" font-size="${fontSize}" fill="${color}"
        text-anchor="start">${escapeXml(line)}</text>`;
    })
    .join("\n");

  // Icon badges - evenly spaced along the bottom-left area.
  const badgeY = height - Math.round(height * 0.22);
  const badgeRadius = Math.round(height * 0.06);
  const badgeSpacing = Math.round(width * 0.16);
  const badgesSvg = badgeLabels
    .slice(0, 3)
    .map((label, i) =>
      iconBadgeSvg(
        startX + badgeRadius + i * badgeSpacing,
        badgeY,
        badgeRadius,
        i,
        label,
        accentColor
      )
    )
    .join("\n");

  // CTA button - fixed short text so it never garbles.
  const btnWidth = Math.round(width * 0.26);
  const btnHeight = Math.round(height * 0.11);
  const btnX = startX;
  const btnY = height - Math.round(height * 0.06) - btnHeight;
  const ctaSvg = `
    <rect x="${btnX}" y="${btnY}" width="${btnWidth}" height="${btnHeight}"
      rx="${Math.round(btnHeight * 0.15)}" fill="${accentColor}" />
    <text x="${btnX + btnWidth / 2}" y="${btnY + btnHeight / 2 + fontSize * 0.14}"
      font-family="Arial, Helvetica, sans-serif" font-weight="800"
      font-size="${Math.round(btnHeight * 0.34)}" fill="#101828"
      text-anchor="middle">${escapeXml(ctaText)}</text>
  `;

  // Dark gradient wash on the left 60% so text stays readable over any photo.
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="wash" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="black" stop-opacity="0.75" />
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

const BACKGROUND_STYLE = `Photorealistic professional photography, dark navy
studio background, cinematic lighting, high quality advertising photograph.
Absolutely no text, letters, numbers, words, icons, buttons, or graphic
overlays anywhere in the image - just the photographic scene itself.`;

export async function createArticleImage(title, topic, badgeLabels) {
  const prompt = `A young professional person thoughtfully working at a
laptop, representing: ${topic}. ${BACKGROUND_STYLE}`;
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
