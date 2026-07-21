// Shared helper: calls Google's Gemini API (free tier - no card, no cost)
// and returns plain text. Used by all agents so there's one place to change
// models/settings.
//
// Uses gemini-2.5-flash-lite for the highest free daily request allowance.
// Free tier limits move around (Google has cut them before) - if you start
// hitting 429 errors, check ai.google.dev for current limits, or spread the
// weekly agents across separate days instead of running them all at once.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash-lite";

export async function askLLM(systemPrompt, userPrompt, maxTokens = 2000) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  if (!candidate) {
    throw new Error(`Gemini returned no content: ${JSON.stringify(data)}`);
  }
  return candidate.content.parts.map((p) => p.text).join("\n");
}

// Strips markdown code fences if the model wraps JSON in them
export function cleanJson(text) {
  return text.replace(/```json|```/g, "").trim();
}
