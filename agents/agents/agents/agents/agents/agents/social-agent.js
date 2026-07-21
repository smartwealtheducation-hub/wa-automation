import { loadLatestPost, writeSocialPost } from "./social-shared.js";

const { FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN } = process.env;

async function postToFacebook(message) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        access_token: FB_PAGE_ACCESS_TOKEN,
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Facebook post failed ${res.status}: ${errText}`);
  }

  return await res.json();
}

async function main() {
  const post = loadLatestPost();
  console.log("Writing Facebook post for:", post.title);
  const message = await writeSocialPost(
    post,
    "Facebook: 2-4 sentences, conversational, max 2 relevant hashtags, link included naturally in the text."
  );

  console.log("Posting to Facebook...");
  const result = await postToFacebook(message);

  console.log("Posted:", result.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
