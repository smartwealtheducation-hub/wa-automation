import fs from "fs";
import { askLLM, cleanJson } from "./llm-client.js";
import { createArticleImage } from "./image-agent.js";

const {
  WP_SITE_URL,
  WP_USERNAME,
  WP_APP_PASSWORD,
  WA_AFFILIATE_LINK,
  SITE_NICHE,
} = process.env;

const USED_TOPICS_FILE = new URL("../used-topics.json", import.meta.url);

function loadUsedTopics() {
  try {
    return JSON.parse(fs.readFileSync(USED_TOPICS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveUsedTopics(topics) {
  fs.writeFileSync(USED_TOPICS_FILE, JSON.stringify(topics, null, 2));
}

// Step 1: pick a fresh, low-competition beginner topic
async function pickTopic(usedTopics) {
  const prompt = `You are a keyword researcher for a website in this niche: "${SITE_NICHE}".

Suggest ONE specific, long-tail blog post topic aimed at total beginners who are
confused about starting an online business (NOT people already comparing platforms
or searching brand names). Avoid generic saturated terms like "make money online"
or any platform review.

Topics already used (do not repeat or closely overlap):
${usedTopics.length ? usedTopics.join("\n") : "(none yet)"}

Respond ONLY with JSON, no preamble, no code fences:
{"topic": "...", "target_keyword": "...", "title": "SEO-friendly blog title"}`;

  const raw = await askLLM(
    "You are a precise SEO keyword researcher. Respond only with valid JSON.",
    prompt,
    500
  );
  return JSON.parse(cleanJson(raw));
}

// Step 2: write the full article
async function writeArticle(topicData) {
  const prompt = `Write a complete, genuinely helpful blog post for total beginners.

Title: ${topicData.title}
Target keyword: ${topicData.target_keyword}
Topic: ${topicData.topic}
Site niche: ${SITE_NICHE}

Requirements:
- 900-1200 words, real practical value, not fluff
- Use the target keyword naturally 3-5 times, including in the first paragraph
- Use clear H2 subheadings (as HTML <h2> tags)
- Plain, friendly, beginner-safe tone
- Affiliate link placement (IMPORTANT - do this naturally, not as a dump at the end):
  - Place ONE mention of ${WA_AFFILIATE_LINK} at the point in the article where a
    beginner would realistically be asking "ok, where do I actually go to do this
    step by step?" - usually mid-to-late article, right after you've explained a
    concept that WA's training covers, not before you've given real value first.
  - Optionally one more low-key mention in a closing paragraph if it fits naturally.
  - Do NOT front-load the link in the intro, and do not repeat it more than twice.
- At the very top of the body, before any other content, include this exact
  disclosure line in a <p><em> tag (required for legal compliance - do not omit
  or alter it): "This post contains an affiliate link. If you sign up through it,
  I may earn a commission at no extra cost to you."
- Include a short meta description (150-160 characters, compelling, includes the
  target keyword) - return this separately in the JSON, not in the body.
- Suggest 2-3 internal link anchor text ideas (phrases in the article that could
  later link to other posts on the same site) - return separately, do not create
  fake links in the body.
- Output valid HTML for the WordPress post body (paragraphs in <p>, headings in <h2>).
  Do not include <html>, <head>, or <body> tags - just the content HTML.
- Do not include the title in the body (WordPress will add it separately)

Respond ONLY with JSON, no preamble, no code fences:
{"body_html": "...", "meta_description": "...", "internal_link_ideas": ["...", "..."]}`;

  const raw = await askLLM(
    "You are an experienced content writer who writes clear, honest, SEO-aware, legally compliant articles for beginners. Respond only with valid JSON.",
    prompt,
    3500
  );
  return JSON.parse(cleanJson(raw));
}

// Step 3: publish to WordPress
async function publishToWordPress(title, contentHtml, metaDescription, featuredMediaId) {
  const auth = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString(
    "base64"
  );

  const res = await fetch(`${WP_SITE_URL}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      title,
      content: contentHtml,
      excerpt: metaDescription, // used by most SEO plugins as the meta description
      featured_media: featuredMediaId,
      status: "publish", // fully unattended, as requested
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WordPress publish failed ${res.status}: ${errText}`);
  }

  return await res.json();
}

async function main() {
  const usedTopics = loadUsedTopics();

  console.log("Picking topic...");
  const topicData = await pickTopic(usedTopics.map((t) => t.title));

  console.log("Writing article:", topicData.title);
  const article = await writeArticle(topicData);

  console.log("Generating header image...");
  const image = await createArticleImage(topicData.title, topicData.topic);

  const bodyWithImage = `<img src="${image.url}" alt="${topicData.title}" style="width:100%;height:auto;" />\n${article.body_html}`;

  console.log("Publishing to WordPress...");
  const post = await publishToWordPress(
    topicData.title,
    bodyWithImage,
    article.meta_description,
    image.id
  );

  usedTopics.push({ title: topicData.title, date: new Date().toISOString() });
  saveUsedTopics(usedTopics);

  // Pass data to the social agents via a shared file (same CI run)
  fs.writeFileSync(
    new URL("../latest-post.json", import.meta.url),
    JSON.stringify(
      {
        title: topicData.title,
        url: post.link,
        excerpt: topicData.topic,
        meta_description: article.meta_description,
        internal_link_ideas: article.internal_link_ideas,
        image_url: image.url,
      },
      null,
      2
    )
  );

  console.log("Published:", post.link);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});s+