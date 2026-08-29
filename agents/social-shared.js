import fs from "fs";
import { askLLM } from "./llm-client.js";

export function loadLatestPost() {
  const path = new URL("../latest-post.json", import.meta.url);
  if (!fs.existsSync(path)) {
    throw new Error(
      "No latest-post.json found - run the content agent first."
    );
  }
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

// Generates platform-specific social copy that always ends with a genuine,
// topic-relevant question to invite comments/engagement.
export async function writeSocialPost(post, platformInstructions) {
  const prompt = `Write a social media post promoting this new blog article.

Title: ${post.title}
Topic: ${post.excerpt}
Link: ${post.url}

Platform-specific instructions:
${platformInstructions}

Always required:
- Sound like a real person sharing something useful, not an ad
- End the post with ONE genuine, specific question related to the article's
  topic that invites people to comment with their own experience or opinion
  (not a generic "what do you think?" - make it specific to the topic)`;

  return await askLLM(
    "You write natural, platform-appropriate, non-salesy social media copy that ends with an engaging, topic-specific question.",
    prompt,
    350
  );
}
