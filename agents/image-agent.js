// Generates and uploads images - completely free via Pollinations.ai (no
// account, no API key, no cost). Uses the "flux" model, which Pollinations
// keeps free and unlimited (their higher-end models like Nanobanana/Seedream
// cost internal credits even through Pollinations, so they're not used here).
// Prompts are written for flat vector/icon-style illustration specifically,
// since budget-tier free models render this style far more crisply than
// attempts at photorealism, which tends to come out blurry or garbled.
// Trade-off vs a paid provider: no uptime guarantee and lower/variable rate
// limits (roughly one request per ~15 seconds on anonymous use) - fine for
// a weekly job, not for high-volume use.
const { WP_SITE_URL, WP_USERNAME, WP_APP_PASSWORD } = process.env;

async function generateImage(prompt, width = 1024, height = 1024) {
  const encoded = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&nologo=true&model=flux`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Image generation failed ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function uploadImageToWordPress(imageBuffer, filename, altText) {
  const auth = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString(
    "base64"
  );
  const res = await fetch(`${WP_SITE_URL}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
    body: imageBuffer,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `WordPress media upload failed ${res.status}: ${errText}`
    );
  }
  const media = await res.json();
  await fetch(`${WP_SITE_URL}/wp-json/wp/v2/media/${media.id}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ alt_text: altText }),
  });
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
