// Shared helper: calls Google's Gemini API (free tier - no card, no cost)
// and returns plain text. Used by all agents so there's one place to change
// models/settings.
//
// Uses gemini-3.5-flash-lite as the primary model (highest free daily
// request allowance), with gemini-2.5-flash as an automatic fallback if the
// primary model is down. Google's free-tier models occasionally experience
// widespread 503 "high demand" outages lasting hours (a known, recurring,
// publicly-reported issue, not specific to this account) - falling back to
// a different model avoids losing an entire day's automation to it.
//
// Includes automatic retries with backoff for transient errors (429 rate
// limit, 500/503 server overload) on each model before moving to the next.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODELS = ["gemini-3.5-flash-lite", "gemini-2.5-flash"];
const MAX_RETRIES_PER_MODEL = 3;
const RETRY_STATUS_CODES = [429, 500, 502, 503, 504];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callModel(model, systemPrompt, userPrompt, maxTokens) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
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
    const err = new Error(`Gemini API error ${res.status}: ${errText}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  if (!candidate) {
    throw new Error(`Gemini returned no content: ${JSON.stringify(data)}`);
  }
  return candidate.content.parts.map((p) => p.text).join("\n");
}

export async function askLLM(systemPrompt, userPrompt, maxTokens = 2000) {
  let lastError;

  for (const model of MODELS) {
    for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
      try {
        return await callModel(model, systemPrompt, userPrompt, maxTokens);
      } catch (err) {
        lastError = err;
        const shouldRetry =
          RETRY_STATUS_CODES.includes(err.status) &&
          attempt < MAX_RETRIES_PER_MODEL;

        if (shouldRetry) {
          const waitMs = attempt * 15000;
          console.log(
            `${model} returned ${err.status} (attempt ${attempt}/${MAX_RETRIES_PER_MODEL}) - retrying in ${waitMs / 1000}s...`
          );
          await sleep(waitMs);
        } else if (RETRY_STATUS_CODES.includes(err.status)) {
          console.log(
            `${model} still failing after ${MAX_RETRIES_PER_MODEL} attempts - trying next model...`
          );
        } else {
          throw err; // non-retryable error (bad request, etc) - fail fast
        }
      }
    }
  }

  throw lastError;
}

// Strips markdown code fences if the model wraps JSON in them
export function cleanJson(text) {
  return text.replace(/```json|```/g, "").trim();
}
