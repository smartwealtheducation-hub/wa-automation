// Shared helper: calls Google's Gemini API (free tier - no card, no cost)
// and returns plain text. Used by all agents so there's one place to change
// models/settings.
//
// Uses gemini-3.5-flash-lite for the highest free daily request allowance.
// Free tier limits move around (Google has cut them before) - if you start
// hitting 429 errors, check ai.google.dev for current limits, or spread the
// weekly agents across separate days instead of running them all at once.
//
// Includes automatic retries with backoff for transient errors (429 rate
// limit, 500/503 server overload) - these happen occasionally on Google's
// side and usually clear up within a minute, so retrying avoids failing an
// entire weekly run over a temporary hiccup.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3.5-flash-lite";
const MAX_RETRIES = 4;
const RETRY_STATUS_CODES = [429, 500, 502, 503, 504];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function askLLM(systemPrompt, userPrompt, maxTokens = 2000) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
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

    if (res.ok) {
      const data = await res.json();
      const candidate = data.candidates?.[0];
      if (!candidate) {
        throw new Error(`Gemini returned no content: ${JSON.stringify(data)}`);
      }
      return candidate.content.parts.map((p) => p.text).join("\n");
    }

    const errText = await res.text();
    lastError = new Error(`Gemini API error ${res.status}: ${errText}`);

    const shouldRetry =
      RETRY_STATUS_CODES.includes(res.status) && attempt < MAX_RETRIES;

    if (!shouldRetry) {
      throw lastError;
    }

    const waitMs = attempt * 15000; // 15s, 30s, 45s...
    console.log(
      `Gemini returned ${res.status} (attempt ${attempt}/${MAX_RETRIES}) - retrying in ${waitMs / 1000}s...`
    );
    await sleep(waitMs);
  }

  throw lastError;
}

// Strips markdown code fences if the model wraps JSON in them
export function cleanJson(text) {
  return text.replace(/```json|```/g, "").trim();
}
