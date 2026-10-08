import fs from "fs";
import { askLLM, cleanJson } from "./llm-client.js";
import { createArticleImage, createInlineImage } from "./image-agent.js";

const {
  WP_SITE_URL,
  WP_USERNAME,
  WP_APP_PASSWORD,
  WA_AFFILIATE_LINK,
  SITE_NICHE,
  WC_CONSUMER_KEY,
  WC_CONSUMER_SECRET,
  YOUTUBE_API_KEY,
  YOUTUBE_CHANNEL_ID,
  YOUTUBE_PLAYLIST_GENERAL,
  YOUTUBE_PLAYLIST_AFFILIATE_MARKETING,
  YOUTUBE_PLAYLIST_AI_BUSINESS,
  YOUTUBE_PLAYLIST_PASSIVE_INCOME,
  YOUTUBE_PLAYLIST_TRADING,
} = process.env;

// Maps each content category to its matching YouTube playlist ID (via env
// vars/secrets). If a category has no playlist configured (or the playlist
// is empty), video selection falls back to the Affiliate Marketing playlist,
// and only then to the channel's general uploads.
const PLAYLIST_BY_CATEGORY = {
  "general online business": YOUTUBE_PLAYLIST_GENERAL,
  "affiliate marketing": YOUTUBE_PLAYLIST_AFFILIATE_MARKETING,
  "AI business opportunities": YOUTUBE_PLAYLIST_AI_BUSINESS,
  "passive income opportunities": YOUTUBE_PLAYLIST_PASSIVE_INCOME,
  trading: YOUTUBE_PLAYLIST_TRADING,
};

const USED_TOPICS_FILE = new URL("../used-topics.json", import.meta.url);
const USED_VIDEOS_FILE = new URL("../used-videos.json", import.meta.url);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function loadUsedVideos() {
  try {
    const data = JSON.parse(fs.readFileSync(USED_VIDEOS_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// Keeps the most recent 60 video IDs (oldest first), so old videos
// naturally re-enter rotation instead of being excluded forever.
function saveUsedVideos(videoIds) {
  const trimmed = videoIds.slice(-60);
  fs.writeFileSync(USED_VIDEOS_FILE, JSON.stringify(trimmed, null, 2));
}

// Returns true if any entry in used-topics.json was published on today's
// UTC calendar date. This is what prevents duplicate articles when the
// 09:00 and 13:00 UTC cron triggers (or a manual run) fire on the same day.
function hasPublishedToday(usedTopics) {
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" in UTC
  return usedTopics.some((t) => t.date && t.date.slice(0, 10) === today);
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

// The site covers several distinct sub-niches. Rotating through them evenly
// (rather than letting the AI freely pick) keeps coverage balanced.
// isFinance: true switches on stricter educational-only writing rules, an
// automatic risk disclaimer, and makes the Wealthy Affiliate mention optional.
const TOPIC_CATEGORIES = [
  {
    name: "general online business",
    guidance:
      "General beginner online business topics: choosing a business model, avoiding scams, basic tools/mindset needed to start.",
  },
  {
    name: "affiliate marketing",
    guidance:
      "Affiliate marketing specifically: how it works, how beginners pick a niche or products, common mistakes, how commissions/tracking work - written for someone who has never heard of affiliate marketing before.",
  },
  {
    name: "AI business opportunities",
    guidance:
      "Using AI tools to start or run a small online business: content creation, automation, AI side-hustle ideas - practical and beginner-safe, not hype-y AI-will-replace-everything content.",
  },
  {
    name: "passive income opportunities",
    guidance:
      "Realistic passive/semi-passive income ideas for beginners: what 'passive' actually means (most take upfront work), honest examples, how to evaluate if an opportunity is legitimate.",
  },
  {
    name: "trading",
    isFinance: true,
    guidance:
      "Beginner-friendly trading and investing EDUCATION: how markets work, key terms, risk management, position sizing, demo accounts, common beginner mistakes, and how to spot scams or get-rich-quick trading courses. Purely educational: no specific buy/sell calls, no price predictions, no promises of profit.",
  },
];

// Cycles through the categories in order based on how many articles have
// been published so far, so coverage stays even rather than random.
function pickTopicCategory(usedTopics) {
  const index = usedTopics.length % TOPIC_CATEGORIES.length;
  return TOPIC_CATEGORIES[index];
}

async function pickTopic(usedTopics, category) {
  const prompt = `You are a keyword researcher for a website in this niche: "${SITE_NICHE}".

Today's specific content category: ${category.name}
Focus for this category: ${category.guidance}

Suggest ONE specific, long-tail blog post topic within that category, aimed at
total beginners who are confused about getting started (NOT people already
comparing platforms or searching brand names). Avoid generic saturated terms
like "make money online" or any platform review.

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

async function writeArticle(topicData, category) {
  const standardAffiliateBlock = `- Affiliate link placement (IMPORTANT - do this naturally, not as a dump at the end):
  - Place ONE mention of ${WA_AFFILIATE_LINK} at the point in the article where a
    beginner would realistically be asking "ok, where do I actually go to do this
    step by step?" - usually mid-to-late article, right after you've explained a
    concept that WA's training covers, not before you've given real value first.
  - Optionally one more low-key mention in a closing paragraph if it fits naturally.
  - Do NOT front-load the link in the intro, and do not repeat it more than twice.
- Disclosure placement (IMPORTANT): do NOT put the disclosure at the very top of
  the article. Instead, place this exact disclosure line in a <p><em> tag
  immediately ABOVE the <h2> heading of whichever section contains the
  ${WA_AFFILIATE_LINK} mention - directly before that heading, nowhere else:
  "This post contains an affiliate link. If you sign up through it, I may earn a
  commission at no extra cost to you."`;

  const financeAffiliateBlock = `- This is a trading/finance topic and must stay strictly educational: no specific
  buy/sell recommendations, no price predictions, no claims of guaranteed or typical
  profits. Be honest that most beginners lose money and that risk management comes first.
- Wealthy Affiliate does not teach trading, so do NOT present it as a way to learn or
  profit from trading. Only mention ${WA_AFFILIATE_LINK} (at most once) if it fits
  naturally in a short side note about building a separate online income skill set.
  If it does not fit naturally, leave the link out entirely - and in that case do NOT
  include any affiliate disclosure line. If you do include the link, place this exact
  disclosure line in a <p><em> tag immediately ABOVE the <h2> heading of the section
  containing it: "This post contains an affiliate link. If you sign up through it, I
  may earn a commission at no extra cost to you."
- Do not write your own risk disclaimer - one is added automatically at the end.`;

  const affiliateBlock = category?.isFinance
    ? financeAffiliateBlock
    : standardAffiliateBlock;

  const prompt = `Write a complete, genuinely helpful blog post for total beginners.

Title: ${topicData.title}
Target keyword: ${topicData.target_keyword}
Topic: ${topicData.topic}
Site niche: ${SITE_NICHE}

Requirements:
- 1300-1600 words (target around 1500), real practical value, not fluff -
  this length matters for SEO, so do not undershoot it
- Use the target keyword naturally 4-6 times, including in the first paragraph,
  and make sure it appears verbatim (exact same wording) at least once in the
  second half of the article - this exact-match instance will later be turned
  into an outbound citation link, so do not paraphrase it away in the back half.
- Use clear H2 subheadings (as HTML <h2> tags) - aim for 5-7 sections given the length
- Plain, friendly, beginner-safe tone
${affiliateBlock}
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

// ---- WooCommerce product showcase ----

// Returns up to `count` random published products. main() uses the first 3
// for the top-of-article showcase and the next 2 for the end-of-article cards.
async function getStoreProducts(count = 5) {
  if (!WC_CONSUMER_KEY || !WC_CONSUMER_SECRET) {
    console.log("No WooCommerce keys set, skipping product showcase.");
    return [];
  }

  const url = `${WP_SITE_URL}/wp-json/wc/v3/products?per_page=30&status=publish&consumer_key=${WC_CONSUMER_KEY}&consumer_secret=${WC_CONSUMER_SECRET}`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.log("WooCommerce fetch failed, skipping product showcase:", err.message);
    return [];
  }

  if (!res.ok) {
    console.log(`WooCommerce API returned ${res.status}, skipping product showcase.`);
    return [];
  }

  const products = await res.json();
  if (!Array.isArray(products) || products.length === 0) return [];

  const shuffled = [...products].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).map((p) => ({
    name: p.name,
    price: p.price_html ? p.price_html.replace(/<[^>]*>/g, "") : p.price,
    url: p.permalink,
    image: p.images?.[0]?.src || null,
  }));
}

function buildProductShowcaseHtml(products, heading = "") {
  if (!products.length) return "";

  const cards = products
    .map(
      (p) => `
    <div style="flex:1;min-width:180px;max-width:220px;border:1px solid #e0e0e0;border-radius:8px;padding:12px;text-align:center;">
      ${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" style="max-width:100%;height:auto;border-radius:6px;margin-bottom:8px;" />` : ""}
      <p style="font-weight:600;margin:8px 0 4px;">${escapeHtml(p.name)}</p>
      <p style="margin:0 0 10px;">${escapeHtml(p.price)}</p>
      <a href="${escapeHtml(p.url)}" style="display:inline-block;padding:8px 16px;background:#2271b1;color:#fff;text-decoration:none;border-radius:4px;">Shop Now</a>
    </div>`
    )
    .join("");

  const headingHtml = heading
    ? `<p style="text-align:center;font-weight:700;font-size:1.1em;margin:32px 0 0;">${escapeHtml(heading)}</p>`
    : "";

  return `${headingHtml}<div style="display:flex;flex-wrap:wrap;gap:16px;justify-content:center;margin:24px 0;">${cards}</div>`;
}

function insertAfterFirstParagraph(bodyHtml, showcaseHtml) {
  if (!showcaseHtml) return bodyHtml;
  const closeTagIndex = bodyHtml.indexOf("</p>");
  if (closeTagIndex === -1) return showcaseHtml + bodyHtml;
  const insertAt = closeTagIndex + "</p>".length;
  return (
    bodyHtml.slice(0, insertAt) + showcaseHtml + bodyHtml.slice(insertAt)
  );
}

// ---- Wikipedia outbound citation ----

// Checks that a Wikipedia article with this title really exists (following
// redirects) and is not a disambiguation page. Returns {title, url} or null.
async function verifyWikipediaTitle(title) {
  const apiUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(
    title
  )}&redirects=1&prop=pageprops&ppprop=disambiguation&format=json&origin=*`;

  let res;
  try {
    res = await fetch(apiUrl, {
      headers: {
        "User-Agent": `ContentAutomationBot/1.0 (${WP_SITE_URL || "no-site-url-set"})`,
      },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const data = await res.json();
  const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
  const page = pages[0];
  if (!page || page.missing !== undefined || page.pageprops?.disambiguation !== undefined) {
    return null;
  }

  return {
    title: page.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(
      page.title.replace(/ /g, "_")
    )}`,
  };
}

// Asks the LLM for a broad concept article (e.g. "Affiliate marketing") and
// verifies it exists; plain Wikipedia text search was returning unrelated
// pages (people, niche topics). Falls back to text search if that fails.
async function getWikipediaLink(topicData) {
  try {
    const raw = await askLLM(
      "You pick real English Wikipedia article titles. Respond only with valid JSON.",
      `Article title: ${topicData.title}
Topic: ${topicData.topic}

Name ONE real, broad, general-concept English Wikipedia article title that a
reader of this blog post could use for background (for example "Affiliate
marketing", "Passive income", "Risk management", "Artificial intelligence").
It must be a general concept - NOT a person, company, website or product.

Respond ONLY with JSON, no preamble, no code fences:
{"wikipedia_title": "..."}`,
      100
    );
    const suggested = JSON.parse(cleanJson(raw)).wikipedia_title;
    if (suggested) {
      const verified = await verifyWikipediaTitle(String(suggested));
      if (verified) return verified;
      console.log(`Wikipedia title "${suggested}" could not be verified, trying text search.`);
    }
  } catch (err) {
    console.log("Wikipedia title suggestion failed, trying text search:", err.message);
  }

  const query = topicData.target_keyword || topicData.topic;
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
    query
  )}&format=json&origin=*&srlimit=1`;

  let res;
  try {
    res = await fetch(searchUrl, {
      headers: {
        "User-Agent": `ContentAutomationBot/1.0 (${WP_SITE_URL || "no-site-url-set"})`,
      },
    });
  } catch (err) {
    console.log("Wikipedia search failed, skipping outbound link:", err.message);
    return null;
  }

  if (!res.ok) {
    console.log(`Wikipedia API returned ${res.status}, skipping outbound link.`);
    return null;
  }

  const data = await res.json();
  const result = data?.query?.search?.[0];
  if (!result) return null;

  const title = result.title;
  return {
    title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(
      title.replace(/ /g, "_")
    )}`,
  };
}

// Fallback: a standalone "further reading" paragraph, only used if we can't
// safely find the keyword verbatim in the body to link inline instead.
function buildWikipediaLinkHtml(wiki) {
  if (!wiki) return "";
  return `<p>For more background on this topic, see the <a href="${wiki.url}" target="_blank" rel="noopener noreferrer">Wikipedia article on ${escapeHtml(wiki.title)}</a>.</p>`;
}

function insertAfterImage2(bodyHtml, image2Url, wikiHtml) {
  if (!wikiHtml) return bodyHtml;
  const marker = `<img src="${image2Url}"`;
  const idx = bodyHtml.indexOf(marker);
  if (idx === -1) return bodyHtml + wikiHtml;
  const closeIdx = bodyHtml.indexOf("/>", idx) + 2;
  return bodyHtml.slice(0, closeIdx) + wikiHtml + bodyHtml.slice(closeIdx);
}

// Finds a safe, linkable occurrence of `keyword` in the HTML: not inside an
// existing tag (e.g. not inside an alt="" or href="" attribute), preferring
// an occurrence in the second half of the article.
function findSafeKeywordMatch(html, keyword) {
  if (!keyword) return null;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\b${escaped}\\b`, "gi");
  const candidates = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    const idx = match.index;
    const lastOpen = html.lastIndexOf("<", idx);
    const lastClose = html.lastIndexOf(">", idx);
    const insideTag = lastOpen > lastClose;
    if (!insideTag) candidates.push({ index: idx, text: match[0] });
  }
  if (!candidates.length) return null;

  const half = html.length / 2;
  const laterCandidates = candidates.filter((c) => c.index > half);
  const pool = laterCandidates.length ? laterCandidates : candidates;
  return pool[pool.length - 1];
}

// Wraps one occurrence of the target keyword in the body with a link to the
// Wikipedia article. Returns null if no safe match is found, so the caller
// can fall back to the paragraph method instead.
function linkifyKeywordToWikipedia(bodyHtml, keyword, wiki) {
  if (!wiki || !keyword) return null;
  const found = findSafeKeywordMatch(bodyHtml, keyword);
  if (!found) return null;

  const linked = `<a href="${wiki.url}" target="_blank" rel="noopener noreferrer">${found.text}</a>`;
  return (
    bodyHtml.slice(0, found.index) +
    linked +
    bodyHtml.slice(found.index + found.text.length)
  );
}

// ---- YouTube video embed ----

async function getUploadsPlaylistId() {
  const url = `https://www.googleapis.com/youtube/v3/channels?key=${YOUTUBE_API_KEY}&id=${YOUTUBE_CHANNEL_ID}&part=contentDetails`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.log("YouTube channel lookup failed:", err.message);
    return null;
  }

  if (!res.ok) {
    console.log(`YouTube channel lookup returned ${res.status}.`);
    return null;
  }

  const data = await res.json();
  return data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
}

// Fetches EVERY video in a playlist (up to 250, 50 per page). The old code
// only looked at the first 50 items, and for the channel's uploads playlist
// that is always just the newest videos - one reason the same clip kept
// being picked.
async function fetchPlaylistVideos(playlistId) {
  const videos = [];
  let pageToken = "";

  for (let page = 0; page < 5; page++) {
    const url =
      `https://www.googleapis.com/youtube/v3/playlistItems?key=${YOUTUBE_API_KEY}` +
      `&playlistId=${playlistId}&part=snippet,status&maxResults=50` +
      (pageToken ? `&pageToken=${pageToken}` : "");

    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      console.log("YouTube playlist fetch failed:", err.message);
      break;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.log(
        `YouTube playlistItems returned ${res.status} for playlist ${playlistId}: ${body.slice(0, 200)}`
      );
      break;
    }

    const data = await res.json();
    for (const item of data.items || []) {
      const videoId = item.snippet?.resourceId?.videoId;
      const title = item.snippet?.title || "";
      const privacy = item.status?.privacyStatus;
      // Skip private/deleted entries - they can't be embedded.
      if (!videoId) continue;
      if (privacy === "private") continue;
      if (title === "Private video" || title === "Deleted video") continue;
      videos.push({
        videoId,
        title,
        publishedAt: item.snippet?.publishedAt || "",
      });
    }

    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }

  return videos;
}

// BEGIN pickVideo
// Picks a random video that has not been embedded recently. If every video
// has been used, picks the least recently used one (earliest in the history
// list) so the rotation keeps cycling instead of getting stuck on one clip.
function pickVideo(candidates, usedVideoIds) {
  if (!candidates || !candidates.length) return null;
  const unused = candidates.filter((c) => !usedVideoIds.includes(c.videoId));
  if (unused.length) {
    return unused[Math.floor(Math.random() * unused.length)];
  }
  // lastIndexOf = most recent use. (indexOf would return the OLDEST use of a
  // video that has been used more than once and get stuck on one clip.)
  const rank = (id) => usedVideoIds.lastIndexOf(id);
  return [...candidates].sort((a, b) => rank(a.videoId) - rank(b.videoId))[0];
}
// END pickVideo

async function getVideoForCategory(category, usedVideoIds = []) {
  if (!YOUTUBE_API_KEY) {
    console.log("YOUTUBE_API_KEY not set, skipping video embed.");
    return null;
  }

  const sources = [];
  const categoryPlaylist = (PLAYLIST_BY_CATEGORY[category?.name] || "").trim();
  if (categoryPlaylist) {
    sources.push({ label: `"${category.name}" playlist`, id: categoryPlaylist });
  } else {
    console.log(
      `No playlist secret set for "${category?.name}" - using the Affiliate Marketing playlist instead.`
    );
  }

  // Fallback #1: the Affiliate Marketing playlist (main goal: promote WA).
  const affiliatePlaylist = (YOUTUBE_PLAYLIST_AFFILIATE_MARKETING || "").trim();
  if (affiliatePlaylist && affiliatePlaylist !== categoryPlaylist) {
    sources.push({ label: "Affiliate Marketing playlist (fallback)", id: affiliatePlaylist });
  }

  for (const source of sources) {
    const videos = await fetchPlaylistVideos(source.id);
    console.log(`${source.label}: found ${videos.length} usable videos.`);
    const chosen = pickVideo(videos, usedVideoIds);
    if (chosen) {
      console.log(`Using the ${source.label}.`);
      return { videoId: chosen.videoId, title: chosen.title };
    }
  }

  // Fallback: the whole channel's uploads.
  if (!YOUTUBE_CHANNEL_ID) {
    console.log("YOUTUBE_CHANNEL_ID not set, skipping video embed.");
    return null;
  }
  const uploadsId = await getUploadsPlaylistId();
  if (!uploadsId) {
    console.log("Could not resolve uploads playlist, skipping video embed.");
    return null;
  }
  const uploads = await fetchPlaylistVideos(uploadsId);
  console.log(`Channel uploads: found ${uploads.length} usable videos.`);
  const chosen = pickVideo(uploads, usedVideoIds);
  if (!chosen) return null;
  console.log("Using the channel uploads (fallback).");
  return { videoId: chosen.videoId, title: chosen.title };
}

function buildYouTubeEmbedHtml(video) {
  if (!video) return "";
  const safeTitle = escapeHtml(video.title);
  return `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;margin:24px 0;">
  <iframe src="https://www.youtube.com/embed/${video.videoId}" title="${safeTitle}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
</div>`;
}

// Places the embed right before the final paragraph, so it reads as a
// "watch this, then here's the takeaway" moment near the article's close.
function insertBeforeLastParagraph(bodyHtml, embedHtml) {
  if (!embedHtml) return bodyHtml;
  const lastOpen = bodyHtml.lastIndexOf("<p>");
  if (lastOpen === -1) return bodyHtml + embedHtml;
  return bodyHtml.slice(0, lastOpen) + embedHtml + bodyHtml.slice(lastOpen);
}

// ---- Trading risk disclaimer ----

function buildTradingDisclaimerHtml() {
  return `<p style="font-size:0.9em;"><em>Disclaimer: This article is for educational purposes only and is not financial or investment advice. Trading carries a high risk of loss, and most beginners lose money. Never trade with money you cannot afford to lose, and consider speaking to a qualified, regulated financial adviser.</em></p>`;
}

// ---- WordPress publishing ----

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
  const img1Tag = `<img src="${image1Url}" alt="${escapeHtml(image1Alt)}" style="max-width:100%;height:auto;" />`;
  const img2Tag = `<img src="${image2Url}" alt="${escapeHtml(image2Alt)}" style="max-width:100%;height:auto;" />`;
  let body = bodyHtml.replace("[IMAGE_1]", img1Tag);
  body = body.replace("[IMAGE_2]", img2Tag);
  return body;
}

async function main() {
  const usedTopics = loadUsedTopics();
  const usedVideos = loadUsedVideos();

  if (hasPublishedToday(usedTopics)) {
    console.log(
      "An article was already published today - skipping this run to avoid a duplicate. (This is expected behavior when a retry run fires after a successful earlier run.)"
    );
    return;
  }

  console.log("Fetching existing categories...");
  const categories = await getCategories();

  const category = pickTopicCategory(usedTopics);
  console.log(`Today's category: ${category.name}`);

  console.log("Picking topic...");
  const topicData = await pickTopic(usedTopics.map((t) => t.title), category);

  console.log("Picking category...");
  const categoryId = await pickCategory(categories, topicData);
  console.log(
    categoryId
      ? `Chosen category id: ${categoryId}`
      : "No category match found - will publish without one."
  );

  console.log("Writing article:", topicData.title);
  const article = await writeArticle(topicData, category);

  console.log("Resolving tags:", article.tags?.join(", "));
  const tagIds = await resolveTags(article.tags);

  console.log("Fetching store products for showcase...");
  const products = await getStoreProducts(5);
  console.log(`Found ${products.length} products for showcase.`);
  const topProducts = products.slice(0, 3);
  let endProducts = products.slice(3, 5);
  if (!endProducts.length && topProducts.length) {
    // Store has 3 or fewer products - reuse some so the end cards still show.
    endProducts = [...topProducts].sort(() => Math.random() - 0.5).slice(0, 2);
  }
  const showcaseHtml = buildProductShowcaseHtml(topProducts);
  const endCardsHtml = buildProductShowcaseHtml(endProducts, "More from our store");

  console.log("Finding a related Wikipedia source...");
  const wiki = await getWikipediaLink(topicData);
  console.log(
    wiki ? `Found Wikipedia article: ${wiki.title}` : "No Wikipedia match found, skipping link."
  );

  console.log("Checking for a YouTube video to embed...");
  const video = await getVideoForCategory(category, usedVideos);
  console.log(
    video ? `Found video: ${video.title}` : "No video embed for this article."
  );
  const videoEmbedHtml = buildYouTubeEmbedHtml(video);

  console.log("Generating thumbnail image...");
  const thumbnail = await createArticleImage(topicData.title, topicData.topic, article.tags);
  console.log("Pausing 45s before next upload to respect WordPress rate limits...");
  await sleep(45000);

  console.log("Generating in-article image 1...");
  const inline1 = await createInlineImage(
    topicData.title,
    article.image_prompts.image_1,
    1
  );

  console.log("Pausing 45s before next upload to respect WordPress rate limits...");
  await sleep(45000);

  console.log("Generating in-article image 2...");
  const inline2 = await createInlineImage(
    topicData.title,
    article.image_prompts.image_2,
    2
  );

  let finalBody = insertInlineImages(
    article.body_html,
    inline1.url,
    article.image_prompts.image_1,
    inline2.url,
    article.image_prompts.image_2
  );

  finalBody = insertAfterFirstParagraph(finalBody, showcaseHtml);

  // Try linking the keyword inline first; only fall back to the standalone
  // paragraph if no safe verbatim match was found in the body.
  const inlineLinked = linkifyKeywordToWikipedia(
    finalBody,
    topicData.target_keyword,
    wiki
  );
  if (inlineLinked) {
    finalBody = inlineLinked;
    console.log("Linked target keyword inline to Wikipedia article.");
  } else if (wiki) {
    finalBody = insertAfterImage2(finalBody, inline2.url, buildWikipediaLinkHtml(wiki));
    console.log("Used fallback paragraph for Wikipedia link (keyword not found verbatim).");
  }

  finalBody = insertBeforeLastParagraph(finalBody, videoEmbedHtml);

  // Very end of the article: risk disclaimer (trading only), then 2 store cards.
  if (category.isFinance) {
    finalBody += buildTradingDisclaimerHtml();
  }
  finalBody += endCardsHtml;

  console.log("Publishing to WordPress...");
  const post = await publishToWordPress(
    topicData.title,
    finalBody,
    article.meta_description,
    thumbnail.id,
    categoryId,
    tagIds
  );

  usedTopics.push({
    title: topicData.title,
    category: category.name,
    date: new Date().toISOString(),
  });
  saveUsedTopics(usedTopics);

  // Always write used-videos.json (even when no video was used) so the file
  // exists and the workflow's commit step can track it.
  if (video) usedVideos.push(video.videoId);
  saveUsedVideos(usedVideos);

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
