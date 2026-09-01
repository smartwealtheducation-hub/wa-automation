import { loadLatestPost, writeSocialPost } from "./social-shared.js";

const { FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN } = process.env;

// Posts as a PHOTO post (not a plain text/link post) so the thumbnail image
// actually shows up prominently on the Page, instead of relying on
// Facebook's link-preview scraper to maybe pick up an og:image.
async function postPhotoToFacebook(imageUrl, caption) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/photos`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: imageUrl,
        caption,
        access_token: FB_PAGE_ACCESS_TOKEN,
      }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Facebook photo post failed ${res.status}: ${errText}`);
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

  if (!post.image_url) {
    throw new Error(
      "No image_url in latest-post.json - the content agent's image step must run first."
    );
  }

  console.log("Posting photo to Facebook...");
  const result = await postPhotoToFacebook(post.image_url, message);
  console.log("Posted:", result.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
