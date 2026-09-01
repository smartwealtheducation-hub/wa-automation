// Generates and uploads images via Pollinations.ai using an authenticated
// Secret Key (POLLINATIONS_API_KEY, free to create at enter.pollinations.ai).
// Uses the "flux" model. Prompts are written for flat vector/icon-style
// illustration, which budget-tier models render more cleanly than photorealism.
//
// Each image now makes ONE WordPress API call instead of two - alt_text is
// passed as a query parameter on the same upload request instead of a
// separate follow-up call, to reduce how many requests hit the WordPress
// REST API per run (helps avoid host-level rate limiting).
//
// Includes automatic retries with backoff for transient errors (429 rate
// limit, 500-504 server issues).
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

    const waitMs = attempt * 30000; // 30s, 60s, 90s...
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
    {
      headers: { Authorization: `Bearer ${POLLINATIONS_API_KEY}` },
    },
    "Image generation"
  );
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function uploadImageToWordPress(imageBuffer, filename, altText) {
  const auth = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString(
    "base64"
  );
  // alt_text passed as a query param so this is the ONLY request needed
  // per image, instead of upload + a separate alt-text update call.
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

const STYLE_GUIDANCE = `Style: flat vector illustration, minimalist icon-style
design, bold flat colors, simple geometric shapes, clean crisp lines, high
contrast, plenty of negative space. Absolutely no text, letters, numbers, or
words anywhere in the image. No photorealism, no photographic textures, no
gradients or blur. No people's faces close-up. No logos or brand marks.`;

export async function createArticleImage(title, topic) {
  const prompt = `A flat vector illustration blog header representing: ${topic}.
${STYLE_GUIDANCE} Friendly and welcoming, suitable for a beginner-focused
online business blog.`;
  const imageBuffer = await generateImage(prompt, 1200, 628);
  const filename = `${slugify(title)}-thumbnail.png`;
  return await uploadImageToWordPress(imageBuffer, filename, title);
}

export async function createInlineImage(title, prompt, index) {
  const fullPrompt = `A flat vector illustration for a blog article. Scene:
${prompt}. ${STYLE_GUIDANCE}`;
  const imageBuffer = await generateImage(fullPrompt, 1024, 683);
  const filename = `${slugify(title)}-inline-${index}.png`;
  return await uploadImageToWordPress(imageBuffer, filename, prompt);
}
