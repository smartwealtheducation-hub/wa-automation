// Generates and uploads the article's header/featured image - completely
// free via Pollinations.ai (no account, no API key, no cost). Trade-off vs
// a paid provider: no uptime guarantee and lower/variable rate limits
// (roughly one request per ~15 seconds on anonymous use) - fine for a
// weekly job, not for high-volume use.

const { WP_SITE_URL, WP_USERNAME, WP_APP_PASSWORD } = process.env;

async function generateImage(prompt) {
  const encoded = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true`;

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

// Main export used by content-agent.js
export async function createArticleImage(title, topic) {
  const prompt = `A clean, modern, professional blog header illustration
representing: ${topic}. Flat design style, no text or words anywhere in the
image, simple, friendly, and welcoming, suitable for a beginner-focused
online business blog. No people's faces close-up, no logos.`;

  const imageBuffer = await generateImage(prompt);
  const filename =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 60) + ".png";

  return await uploadImageToWordPress(imageBuffer, filename, title);
}
