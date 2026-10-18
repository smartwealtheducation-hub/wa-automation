// Shared helper: calls Google's Gemini API (free tier - no card, no cost)
// and returns plain text. Used by all agents so there's one place to change
// models/settings.
//
// RESILIENCE (updated 2026-10-18): Google's free-tier models regularly have
// hours-long 503 "high demand" outages. To avoid losing a day's article:
//   1. Several different models are tried in order (including Google's
//      "-latest" aliases, which always point at a currently-supported model).
//   2. Each model gets a few retries with growing waits.
//   3. If EVERY model is overloaded, the whole chain is retried after a long
//      pause (up to ROUNDS times) before giving up.
//   4. A model that doesn't exist any more (404) is skipped, not fatal.
// You can override the model list without editing code by setting a
// GEMINI_MODELS repository variable/secret, e.g. "modelA,modelB,modelC".
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const DEFAULT_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-flash-latest",
];
const MODELS = (process.env.GEMINI_MODELS || "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const MODEL_CHAIN = MODELS.length ? MODELS : DEFAULT_MODELS;

const MAX_RETRIES_PER_MODEL = 3; // attempts per model per round
const ROUNDS = 3; // full passes over the model list
const PAUSE_BETWEEN_ROUNDS_MS = 4 * 60 * 1000; // 4 minutes
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
    const err = new Error(`Gemini returned no content: ${JSON.stringify(data)}`);
    err.status = 503; // treat an empty answer like a transient failure
    throw err;
  }
  return candidate.content.parts.map((p) => p.text).join("\n");
}

export async function askLLM(systemPrompt, userPrompt, maxTokens = 2000) {
  let lastError;

  for (let round = 1; round <= ROUNDS; round++) {
    for (const model of MODEL_CHAIN) {
      for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
        try {
          return await callModel(model, systemPrompt, userPrompt, maxTokens);
        } catch (err) {
          lastError = err;

          // Model name no longer exists / not available to this key: skip it.
          if (err.status === 404) {
            console.log(`${model} not available (404) - trying next model...`);
            break;
          }

          if (!RETRY_STATUS_CODES.includes(err.status)) {
            throw err; // bad request, bad API key, etc - fail fast
          }

          if (attempt < MAX_RETRIES_PER_MODEL) {
            const waitMs = attempt * 15000;
            console.log(
              `${model} returned ${err.status} (attempt ${attempt}/${MAX_RETRIES_PER_MODEL}) - retrying in ${waitMs / 1000}s...`
            );
            await sleep(waitMs);
          } else {
            console.log(
              `${model} still failing after ${MAX_RETRIES_PER_MODEL} attempts - trying next model...`
            );
          }
        }
      }
    }

    if (round < ROUNDS) {
      console.log(
        `All models busy (round ${round}/${ROUNDS}) - waiting ${PAUSE_BETWEEN_ROUNDS_MS / 60000} minutes, then trying again...`
      );
      await sleep(PAUSE_BETWEEN_ROUNDS_MS);
    }
  }

  throw lastError;
}

// Strips markdown code fences if the model wraps JSON in them
export function cleanJson(text) {
  return text.replace(/```json|```/g, "").trim();
}
