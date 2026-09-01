// Generates and uploads images via Pollinations.ai using an authenticated
// Secret Key (POLLINATIONS_API_KEY, free to create at enter.pollinations.ai).
// Uses the "flux" model. Prompts are written for flat vector/icon-style
// illustration, which budget-tier models render more cleanly than photorealism.
//
// The thumbnail gets a bold headline overlaid on top using code (via sharp),
// not asked of the AI model directly - AI-rendered text in images comes out
// garbled/illegible on free-tier models, so the background is generated
// text-free and a crisp, real headline is composited on top afterward. This
// is the same technique behind most professional-looking blog/YouTube
// thumbnails and is what actually drives click-through, not the art alone.
//
// Each image makes ONE WordPress API call (alt_text passed as a query param
// on the same upload request) to minimize requests against WordPress's
// rate limiting. Includes automatic retries with backoff for transient
// errors (429, 500-504) on both the image generation and WordPress calls.
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

// Wraps text into lines that roughly fit maxCharsPerLine.
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

// Overlays a bold, legible headline + a dark gradient band (for contrast)
// onto a generated background image using sharp + SVG compositing.
async function addTitleOverlay(imageBuffer, title, width, height) {
  const lines = wrapText(title.toUpperCase(), 22).slice(0, 3);
  const lineHeight = Math.round(height * 0.11);
  const fontSize = Math.round(height * 0.085);
  const bandHeight = lineHeight * lines.length + Math.round(height * 0.08);
  const bandTop = height - bandHeight;

  const textLines = lines
    .map((line, i) => {
      const y = bandTop + Math.round(height * 0.06) + i * lineHeight + fontSize;
      return `<text x="${width / 2}" y="${y}" font-family="Arial, Helvetica, sans-serif"
        font-weight="900" font-size="${fontSize}" fill="white" text-anchor="middle"
        stroke="black" stroke-width="${Math.round(fontSize * 0.05)}"
        paint-order="stroke">${escapeXml(line)}</text>`;
    })
    .join("\n");

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="black" stop-opacity="0" />
          <stop offset="100%" stop-color="black" stop-opacity="0.75" />
        </linearGradient>
      </defs>
      <rect x="0" y="${bandTop}" width="${width}" height="${bandHeight}" fill="url(#fade)" />
      ${textLines}
    </svg>
  `;

  return sharp(imageBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

const STYLE_GUIDANCE = `Style: flat vector illustration, minimalist icon-style
design, bold flat colors, simple geometric shapes, clean crisp lines, high
contrast, vibrant eye-catching color palette, plenty of negative space in the
upper two-thirds of the frame. Absolutely no text, letters, numbers, or words
anywhere in the image. No photorealism, no photographic textures, no
gradients or blur. No people's faces close-up. No logos or brand marks.`;

export async function createArticleImage(title, topic) {
  const prompt = `A bold, high-contrast, scroll-stopping flat vector
illustration blog header representing: ${topic}. ${STYLE_GUIDANCE} Should
feel exciting and clickable, like a thumbnail designed to grab attention,
while staying friendly and welcoming for a beginner-focused online business
blog.`;
  const width = 1200;
  const height = 628;
  const rawImage = await generateImage(prompt, width, height);
  const withTitle = await addTitleOverlay(rawImage, title, width, height);
  const filename = `${slugify(title)}-thumbnail.png`;
  return await uploadImageToWordPress(withTitle, filename, title);
}

export async function createInlineImage(title, prompt, index) {
  const fullPrompt = `A flat vector illustration for a blog article. Scene:
${prompt}. ${STYLE_GUIDANCE}`;
  const imageBuffer = await generateImage(fullPrompt, 1024, 683);
  const filename = `${slugify(title)}-inline-${index}.png`;
  return await uploadImageToWordPress(imageBuffer, filename, prompt);
}
