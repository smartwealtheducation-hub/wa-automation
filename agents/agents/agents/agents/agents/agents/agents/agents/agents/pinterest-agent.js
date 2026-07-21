import { loadLatestPost, writeSocialPost } from "./social-shared.js";

// Pinterest API v5. Requires a Pinterest app (developers.pinterest.com) with
// a board created in advance - PINTEREST_BOARD_ID is that board's ID.
// Note: Pinterest reviews apps for "Standard" API access before you can post
// publicly at scale - trial/sandbox access may be limited. Check your app's
// current access level in the Pinterest developer dashboard if this fails.
const { PINTEREST_ACCESS_TOKEN, PINTEREST_BOARD_ID } = process.env;

async function createPin(post, description) {
  const res = await fetch("https://api.pinterest.com/v5/pins", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PINTEREST_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      board_id: PINTEREST_BOARD_ID,
      title: post.title.slice(0, 100),
      description,
      link: post.url,
      media_source: {
        source_type: "image_url",
        url: post.image_url,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Pinterest pin failed ${res.status}: ${errText}`);
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

  console.log("Writing Pinterest description for:", post.title);
  const description = await writeSocialPost(
    post,
    `Pinterest: description 100-500 characters. Pinterest works like a search
engine, not a feed - make it keyword-rich and specific about what someone
will learn, not just catchy. Still end with a genuine, topic-specific
question.`
  );

  console.log("Creating Pinterest pin...");
  const result = await createPin(post, description);

  console.log("Pinned:", result.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
