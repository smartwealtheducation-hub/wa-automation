import { loadLatestPost, writeSocialPost } from "./social-shared.js";

// LinkedIn posting requires an access token from a LinkedIn app with the
// "Share on LinkedIn" product enabled (w_member_social scope), and your
// LinkedIn member URN (looks like "urn:li:person:XXXXXXX").
// Get these via LinkedIn's OAuth flow at developer.linkedin.com - this one
// is more manual to set up than Facebook's, since tokens expire (~60 days)
// and need periodic refreshing unless you set up the refresh flow.
const { LINKEDIN_ACCESS_TOKEN, LINKEDIN_MEMBER_URN } = process.env;

async function postToLinkedIn(text) {
  const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author: LINKEDIN_MEMBER_URN,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text },
          shareMediaCategory: "NONE",
        },
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LinkedIn post failed ${res.status}: ${errText}`);
  }

  return await res.json();
}

async function main() {
  const post = loadLatestPost();
  console.log("Writing LinkedIn post for:", post.title);
  const message = await writeSocialPost(
    post,
    "LinkedIn: slightly more professional tone, 3-5 sentences, frame it around a practical lesson or insight, 2-3 relevant hashtags at the end, link included naturally in the text."
  );

  console.log("Posting to LinkedIn...");
  const result = await postToLinkedIn(message);

  console.log("Posted:", result.id || "success");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
