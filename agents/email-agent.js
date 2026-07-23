import fs from "fs";
import { askLLM, cleanJson } from "./llm-client.js";

const { KIT_API_KEY, WA_AFFILIATE_LINK, SITE_NICHE } = process.env;

function loadLatestPost() {
  const path = new URL("../latest-post.json", import.meta.url);
  if (!fs.existsSync(path)) return null;
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

async function writeEmail(post) {
  const prompt = `Write a short weekly email (150-250 words) for a list of people
interested in starting an online business, niche: "${SITE_NICHE}".

${
  post
    ? `This week's new article: "${post.title}" (${post.url}) - reference it naturally.`
    : "No new article this week - share one practical beginner tip instead."
}

Structure:
- Friendly, direct subject line (return separately)
- Short personal-sounding intro (1-2 sentences)
- One genuinely useful tip or insight
- Natural mention of ${WA_AFFILIATE_LINK} as a resource, not a hard pitch
- Sign-off

Respond ONLY with JSON, no code fences:
{"subject": "...", "preview_text": "...", "body_html": "<p>...</p>..."}`;

  const raw = await askLLM(
    "You write warm, non-pushy marketing emails. Respond only with valid JSON.",
    prompt,
    1200
  );
  return JSON.parse(cleanJson(raw));
}

// Kit (formerly ConvertKit) API v4 - free plan includes full API access and
// unlimited broadcast sends up to 10,000 subscribers, no card required.
// Get your API key: Kit dashboard > Settings > Developer Settings.
async function sendViaKit(email) {
  const res = await fetch("https://api.kit.com/v4/broadcasts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Kit-Api-Key": KIT_API_KEY,
    },
    body: JSON.stringify({
      subject: email.subject,
      preview_text: email.preview_text,
      content: email.body_html,
      description: `Weekly auto email - ${new Date().toISOString().slice(0, 10)}`,
      public: false,
      published_at: new Date().toISOString(),
      send_at: new Date().toISOString(), // send immediately
      // subscriber_filter omitted = sends to all subscribers per Kit's docs.
      // If your account requires an explicit filter, add e.g.:
      // subscriber_filter: [{ all: [{ type: "segment", ids: [YOUR_SEGMENT_ID] }] }]
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Kit broadcast failed ${res.status}: ${errText}`);
  }

  return await res.json();
}

async function main() {
  const post = loadLatestPost();
  console.log("Writing weekly email...");
  const email = await writeEmail(post);

  console.log("Sending via Kit:", email.subject);
  const result = await sendViaKit(email);

  console.log("Sent, broadcast id:", result.broadcast?.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});