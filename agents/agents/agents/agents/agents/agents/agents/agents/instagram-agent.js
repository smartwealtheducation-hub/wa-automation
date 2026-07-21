import { loadLatestPost, writeSocialPost } from "./social-shared.js";

// Instagram posting uses the Facebook Graph API - reuses the same Page
// access token as the Facebook agent, as long as your Instagram professional
// (Business/Creator) account is linked to that Facebook Page.
// IG_BUSINESS_ACCOUNT_ID: found via Graph API Explorer, GET /me/accounts
// then GET /{page-id}?fields=instagram_business_account
const { IG_BUSINESS_ACCOUNT_ID, FB_PAGE_ACCESS_TOKEN } = process.env;

async function createMediaContainer(imageUrl, caption) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${IG_BUSINESS_ACCOUNT_ID}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_url: imageUrl,
        caption,
        access_token: FB_PAGE_ACCESS_TOKEN,
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Instagram container failed ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.id;
}

async function publishMedia(containerId) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${IG_BUSINESS_ACCOUNT_ID}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creation_id: containerId,
        access_token: FB_PAGE_ACCESS_TOKEN,
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Instagram publish failed ${res.status}: ${errText}`);
  }

  return await res.json();
}

async function main() {
  const post = loadLatestPost();
  if (!post.image_url) {
    throw new Error(
      "No image_url in latest-post.json - the content agent's image step must run first."
    );
  }

  console.log("Writing Instagram caption for:", post.title);
  const caption = await writeSocialPost(
    post,
    `Instagram: caption 2-4 sentences, warm and personal tone. Instagram does
NOT make links in captions clickable, so instead of pasting the raw URL,
tell people to check the link in bio or search the exact article title.
Include 3-5 relevant, non-spammy hashtags at the end.`
  );

  console.log("Creating Instagram media container...");
  const containerId = await createMediaContainer(post.image_url, caption);

  console.log("Publishing to Instagram...");
  const result = await publishMedia(containerId);

  console.log("Posted:", result.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
