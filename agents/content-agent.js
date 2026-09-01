import fs from "fs";
import { askLLM, cleanJson } from "./llm-client.js";
import { createArticleImage, createInlineImage } from "./image-agent.js";

const {
  WP_SITE_URL,
  WP_USERNAME,
  WP_APP_PASSWORD,
  WA_AFFILIATE_LINK,
  SITE_NICHE,
} = process.env;

const USED_TOPICS_FILE = new URL("../used-topics.json", import.meta.url);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function wpAuthHeader() {
  const auth = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString(
    "base64"
  );
  return `Basic ${auth}`;
}

async function getCategories() {
  const res = await fetch(
    `${WP_SITE_URL}/wp-json/wp/v2/categories?per_page=100`,
    { headers: { Authorization: wpAuthHeader() } }
  );
  if (!res.ok) {
    console.log("Could not fetch categories, will publish without one.");
    return [];
  }
  const data = await res.json();
  return data.map((c) => ({ id: c.id, name: c.name }));
}

async function pickCategory(categories, topicData) {
  if (!categories.length) return null;

  const namesList = categories.map((c) => c.name).join("\n");
  const prompt = `Here is the list of EXISTING categories on a WordPress blog:
${namesList}

Article title: ${topicData.title}
Article topic: ${topicData.topic}

Pick the SINGLE existing category from the list above that best fits this
article. You MUST choose one exactly as written in the list - do not invent
a new category name or change spelling/capitalization.

Respond ONLY with JSON, no preamble, no code fences:
{"category": "exact name from the list"}`;

  const raw = await askLLM(
    "You choose the best matching category from a fixed list. You only ever respond with one of the exact names given to you.",
    prompt,
    100
  );

  let chosenName;
  try {
    chosenName = JSON.parse(cleanJson(raw)).category;
  } catch {
    return null;
  }

  const match = categories.find(
    (c) => c.name.toLowerCase().trim() === String(chosenName).toLowerCase().trim()
  );
  return match ? match.id : null;
}

// Gets the ID of an existing WordPress tag, or creates it if it doesn't
// exist yet. Unlike categories (pick from existing only), tags are allowed
// to be created fresh each time since trending/viral tags naturally change
// article to article.
async function getOrCreateTag(name) {
  const res = await fetch(`${WP_SITE_URL}/wp-json/wp/v2/tags`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: wpAuthHeader(),
    },
    body: JSON.stringify({ name }),
  });

  if (res.ok) {
    const data = await res.json();
    return data.id;
  }

  // WordPress returns 400 term_exists (with the existing term's id) if the
  // tag is already there - reuse it instead of failing.
  const errData = await res.json().catch(() => null);
  if (errData?.code === "term_exists" && errData?.data?.term_id) {
    return errData.data.term_id;
  }

  console.log(`Could not create/find tag "${name}", skipping it.`);
  return null;
}

async function resolveTags(tagNames) {
  const ids = [];
  for (const name of tagNames || []) {
    const id = await getOrCreateTag(name);
    if (id) ids.push(id);
  }
  return ids;
}

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

async function writeArticle(topicData) {
  const prompt = `Write a complete, genuinely helpful blog post for total beginners.

Title: ${topicData.title}
Target keyword: ${topicData.target_keyword}
Topic: ${topicData.topic}
Site niche: ${SITE_NICHE}

Requirements:
- 1300-1600 words (target around 1500), real practical value, not fluff -
  this length matters for SEO, so do not undershoot it
- Use the target keyword naturally 4-6 times, including in the first paragraph
- Use clear H2 subheadings (as HTML <h2> tags) - aim for 5-7 sections given the length
- Plain, friendly, beginner-safe tone
- Affiliate link placement (IMPORTANT - do this naturally, not as a dump at the end):
  - Place ONE mention of ${WA_AFFILIATE_LINK} at the point in the article where a
    beginner would realistically be asking "ok, where do I actually go to do this
    step by step?" - usually mid-to-late article, right after you've explained a
    concept that WA's training covers, not before you've given real value first.
  - Optionally one more low-key mention in a closing paragraph if it fits naturally.
  - Do NOT front-load the link in the intro, and do not repeat it more than twice.
- Disclosure placement (IMPORTANT - this is different from before): do NOT put
  the disclosure at the very top of the article. Instead, place this exact
  disclosure line in a <p><em> tag immediately ABOVE the <h2> heading of
  whichever section contains the ${WA_AFFILIATE_LINK} mention - directly
  before that heading, nowhere else: "This post contains an affiliate link.
  If you sign up through it, I may earn a commission at no extra cost to you."
- Insert the literal marker [IMAGE_1] on its own line roughly one-third of the
  way through the article, and [IMAGE_2] on its own line roughly two-thirds of
  the way through, at natural section breaks where an illustration would help.
- Include a short meta description (150-160 characters, compelling, includes the
  target keyword) - return this separately in the JSON, not in the body.
- Suggest 2-3 internal link anchor text ideas (phrases in the article that could
  later link to other posts on the same site) - return separately, do not create
  fake links in the body.
- Suggest exactly 3 trending, viral-style tags related to this article's topic
  (short phrases people actually search/follow, not generic single words) -
  return separately, do not put these in the body.
- Output valid HTML for the WordPress post body (paragraphs in <p>, headings in <h2>).
  Do not include <html>, <head>, or <body> tags - just the content HTML.
- Do not include the title in the body (WordPress will add it separately)

Respond ONLY with JSON, no preamble, no code fences:
{
  "body_html": "...",
  "meta_description": "...",
  "internal_link_ideas": ["...", "..."],
  "tags": ["...", "...", "..."],
  "image_prompts": {
    "image_1": "short descriptive scene for the image at [IMAGE_1], no text/words in the image",
    "image_2": "short descriptive scene for the image at [IMAGE_2], no text/words in the image"
  }
}`;

  const raw = await askLLM(
    "You are an experienced content writer who writes clear, honest, SEO-aware, legally compliant articles for beginners. Respond only with valid JSON.",
    prompt,
    5000
  );
  return JSON.parse(cleanJson(raw));
}

async function publishToWordPress(title, contentHtml, metaDescription, featuredMediaId, categoryId, tagIds) {
  const payload = {
    title,
    content: contentHtml,
    excerpt: metaDescription,
    featured_media: featuredMediaId,
    status: "publish",
  };
  if (categoryId) payload.categories = [categoryId];
  if (tagIds && tagIds.length) payload.tags = tagIds;

  const res = await fetch(`${WP_SITE_URL}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: wpAuthHeader(),
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WordPress publish failed ${res.status}: ${errText}`);
  }

  return await res.json();
}

function insertInlineImages(bodyHtml, image1Url, image1Alt, image2Url, image2Alt) {
  const img1Tag = `<img src="${image1Url}" alt="${image1Alt}" style="max-width:100%;height:auto;" />`;
  const img2Tag = `<img src="${image2Url}" alt="${image2Alt}" style="max-width:100%;height:auto;" />`;
  let body = bodyHtml.replace("[IMAGE_1]", img1Tag);
  body = body.replace("[IMAGE_2]", img2Tag);
  return body;
}

async function main() {
  const usedTopics = loadUsedTopics();

  console.log("Fetching existing categories...");
  const categories = await getCategories();

  console.log("Picking topic...");
  const topicData = await pickTopic(usedTopics.map((t) => t.title));

  console.log("Picking category...");
  const categoryId = await pickCategory(categories, topicData);
  console.log(
    categoryId
      ? `Chosen category id: ${categoryId}`
      : "No category match found - will publish without one."
  );

  console.log("Writing article:", topicData.title);
  const article = await writeArticle(topicData);

  console.log("Resolving tags:", article.tags?.join(", "));
  const tagIds = await resolveTags(article.tags);

  console.log("Generating thumbnail image...");
  const thumbnail = await createArticleImage(topicData.title, topicData.topic);

  console.log("Pausing 25s before next upload to respect WordPress rate limits...");
  await sleep(25000);

  console.log("Generating in-article image 1...");
  const inline1 = await createInlineImage(
    topicData.title,
    article.image_prompts.image_1,
    1
  );

  console.log("Pausing 25s before next upload to respect WordPress rate limits...");
  await sleep(25000);

  console.log("Generating in-article image 2...");
  const inline2 = await createInlineImage(
    topicData.title,
    article.image_prompts.image_2,
    2
  );

  const finalBody = insertInlineImages(
    article.body_html,
    inline1.url,
    article.image_prompts.image_1,
    inline2.url,
    article.image_prompts.image_2
  );

  console.log("Publishing to WordPress...");
  const post = await publishToWordPress(
    topicData.title,
    finalBody,
    article.meta_description,
    thumbnail.id,
    categoryId,
    tagIds
  );

  usedTopics.push({ title: topicData.title, date: new Date().toISOString() });
  saveUsedTopics(usedTopics);

  fs.writeFileSync(
    new URL("../latest-post.json", import.meta.url),
    JSON.stringify(
      {
        title: topicData.title,
        url: post.link,
        excerpt: topicData.topic,
        meta_description: article.meta_description,
        internal_link_ideas: article.internal_link_ideas,
        image_url: thumbnail.url,
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
});
