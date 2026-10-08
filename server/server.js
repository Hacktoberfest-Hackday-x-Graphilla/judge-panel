/**
 * THE PITCH COURT — backend
 * POST /api/judge  { pitchText }  ->  { judges: [...with base64 audio], verdict: {...} }
 *
 * Stack: Express + Gemma 4 via Gemini API (or Groq) for the critiques, one call for all 3 judges, + ElevenLabs (TTS, sequential)
 * Requires Node 18+ (uses built-in fetch).
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // Google AI Studio key (used for Gemma 4)
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// Prefer the more stable provider by default, but keep a fallback chain so one flaky API
// does not take the whole app down. Force a specific one with LLM_PROVIDER=gemma or LLM_PROVIDER=groq in .env.
const LLM_PROVIDER = (process.env.LLM_PROVIDER || (GROQ_API_KEY ? "groq" : "gemma")).toLowerCase();
const LLM_PROVIDER_PRIORITY = process.env.LLM_PROVIDER
  ? [LLM_PROVIDER]
  : [LLM_PROVIDER, LLM_PROVIDER === "gemma" ? "groq" : "gemma"].filter((provider, index, list) => list.indexOf(provider) === index);

// Gemma 4 via the Gemini API. Two hosted variants exist: gemma-4-31b-it (better writing)
// and gemma-4-26b-a4b-it (faster). Override with GEMMA_MODEL in .env.
const GEMMA_MODEL = process.env.GEMMA_MODEL || "gemma-4-31b-it";

// NOTE: Groq retired llama-3.1-70b-versatile AND llama-3.3-70b-versatile (shut down 2026-08-16).
// openai/gpt-oss-120b is Groq's recommended production replacement.
// Override via GROQ_MODEL in .env if Groq changes things again (see console.groq.com/docs/models).
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const LLM_MODEL = LLM_PROVIDER === "gemma" ? GEMMA_MODEL : GROQ_MODEL;
const LLM_KEY = LLM_PROVIDER === "gemma" ? GEMINI_API_KEY : GROQ_API_KEY;

// Flash model = half the credit cost per character, which stretches the free tier.
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
const ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_64"; // small payloads, fine for speech

const MIN_PITCH_CHARS = 20;
const MAX_PITCH_CHARS = 3000;
const MAX_SPOKEN_CHARS = 450; // hard cap per judge to protect free-tier credits

if (!LLM_KEY || !ELEVENLABS_API_KEY) {
  console.warn(
    `⚠️  Missing ${LLM_PROVIDER === "gemma" ? "GEMINI_API_KEY" : "GROQ_API_KEY"} and/or ELEVENLABS_API_KEY. ` +
      "Copy .env.example to .env and fill them in."
  );
}

// ─────────────────────────────────────────────────────────────
// Judges
// Voice IDs are ElevenLabs premade voices (available on the free tier).
// Override any of them in .env if a voice isn't available on your account.
// ─────────────────────────────────────────────────────────────
const JUDGES = [
  {
    id: "victor",
    name: "Victor Vance",
    title: "The Cynical VC",
    voiceId: process.env.VICTOR_VOICE_ID || "pNInz6obpgDQGcFmaJgB", // Adam — deep, authoritative
    voiceSettings: { stability: 0.65, similarity_boost: 0.75, style: 0.25 },
    persona:
      "Brutal, impatient venture capitalist who has seen 10,000 decks. Obsessed with TAM, unit economics, CAC/LTV, moats, and monetization. Condescending, uses finance jargon, sighs a lot. Never impressed.",
  },
  {
    id: "aris",
    name: "Dr. Aris Thorne",
    title: "The Tech Purist",
    voiceId: process.env.ARIS_VOICE_ID || "IKne3meq5aSn9XLyUdCD", // Charlie — crisp, analytical
    voiceSettings: { stability: 0.5, similarity_boost: 0.8, style: 0.2 },
    persona:
      "Pedantic principal engineer with a PhD. Obsessed with architectural flaws, tech stack choices, scalability, security vulnerabilities, and technical debt. Dry, surgical, quietly horrified by buzzwords like 'AI-powered' and 'blockchain'.",
  },
  {
    id: "chloe",
    name: "Chloe Chen",
    title: "The Viral Wildcard",
    voiceId: process.env.CHLOE_VOICE_ID || "TX3LPaxmHKxFdv7VOQHJ", // Liam — energetic, punchy
    voiceSettings: { stability: 0.35, similarity_boost: 0.75, style: 0.6 },
    persona:
      "Chaotic brand strategist and social-media-native creator. Focused on branding, memeability, absurdity, humor, and whether it would go viral on TikTok. Fast-talking, uses slang and hyperbole, roasts the name and logo first.",
  },
];

// ─────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const judgeBlock = JUDGES.map(
    (j, i) => `${i + 1}. id="${j.id}" — ${j.name}, ${j.title}\n   Persona: ${j.persona}`
  ).join("\n");

  return `You are the engine behind "The Pitch Court", a comedy show where a panel of three judges roasts startup/hackathon pitches. Be funny, sharp, and specific to the pitch. Roast the IDEA, never the person; no slurs, no hateful or sexual content.

THE PANEL:
${judgeBlock}

RULES:
- Each judge critiques ONLY from their own angle and stays fully in character.
- Reference concrete details from the pitch. Do not be generic.
- "critique": 2-4 sentences, 45-70 words, written to be SPOKEN ALOUD (no markdown, no emojis, no bullet points, no stage directions, no abbreviations that sound odd when read out).
- "roast": ONE short, quotable punchline, max 15 words.
- "score": integer 0-100. Be honest and varied; judges should disagree with each other.
- "verdict.ruling": a short, ALL-CAPS, humorous stamped ruling, 2-5 words (e.g. "REJECTED WITH PASSION", "BARELY LEGAL", "FUNDED OUT OF PITY").
- "verdict.takeaways": exactly 3 short, actionable bullet strings (max 14 words each), genuinely useful under the jokes.
- "verdict.score": integer 0-100 consensus.

OUTPUT: Respond with ONLY a valid JSON object. No markdown fences, no commentary. Exact shape:
{
  "judges": [
    { "id": "victor", "critique": "string", "roast": "string", "score": 0 },
    { "id": "aris",   "critique": "string", "roast": "string", "score": 0 },
    { "id": "chloe",  "critique": "string", "roast": "string", "score": 0 }
  ],
  "verdict": {
    "score": 0,
    "ruling": "STRING",
    "takeaways": ["string", "string", "string"]
  }
}`;
}

// ─────────────────────────────────────────────────────────────
// Groq
// ─────────────────────────────────────────────────────────────
async function callGroq(pitchText) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.9,
      // Reasoning models (gpt-oss) spend part of this budget "thinking", so keep it generous.
      max_completion_tokens: 4000,
      // Keep thinking short so the demo stays fast. Only sent to models that support it.
      ...(GROQ_MODEL.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
      response_format: { type: "json_object" }, // forces syntactically valid JSON
      messages: [
        { role: "system", content: buildSystemPrompt() },
        {
          role: "user",
          content: `Here is the pitch. Judge it.\n\n<pitch>\n${pitchText}\n</pitch>`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Groq API error ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    err.source = "groq";
    throw err;
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned an empty response");
  return content;
}

// ─────────────────────────────────────────────────────────────
// Gemma 4 (via the Gemini API / Google AI Studio key)
// ─────────────────────────────────────────────────────────────
const JUDGEMENT_SCHEMA = {
  type: "object",
  properties: {
    judges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", enum: ["victor", "aris", "chloe"] },
          critique: { type: "string" },
          roast: { type: "string" },
          score: { type: "integer" },
        },
        required: ["id", "critique", "roast", "score"],
      },
    },
    verdict: {
      type: "object",
      properties: {
        score: { type: "integer" },
        ruling: { type: "string" },
        takeaways: { type: "array", items: { type: "string" } },
      },
      required: ["score", "ruling", "takeaways"],
    },
  },
  required: ["judges", "verdict"],
};

/**
 * strict = true : system instruction + JSON schema enforcement (preferred).
 * strict = false: fallback if the API rejects those fields for this model — the system prompt
 *                 is folded into the user message and we rely on the prompt + tolerant parsing.
 */
async function callGemma(pitchText, strict = true) {
  const userText = `Here is the pitch. Judge it.\n\n<pitch>\n${pitchText}\n</pitch>`;

  const body = strict
    ? {
        systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: 4000, // generous: Gemma 4 may "think" before answering
          responseMimeType: "application/json",
          responseJsonSchema: JUDGEMENT_SCHEMA,
        },
      }
    : {
        contents: [{ role: "user", parts: [{ text: `${buildSystemPrompt()}\n\n${userText}` }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 4000 },
      };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMMA_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // A 400 in strict mode is often "this model doesn't accept that field" — retry the plain way once.
    // (An invalid API key also returns 400; the retry fails the same way and the error surfaces.)
    if (res.status === 400 && strict) {
      console.warn(`Gemma strict mode rejected (${text.slice(0, 160)}) — retrying without schema.`);
      return callGemma(pitchText, false);
    }
    const err = new Error(`Gemma API error ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.source = "gemma";
    throw err;
  }

  const data = await res.json();
  // Skip any "thought" parts; keep only the real answer text.
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const content = parts
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");

  if (!content) {
    const why = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || "unknown";
    throw new Error(`Gemma returned no text (reason: ${why})`);
  }
  return content;
}

async function callLLM(pitchText) {
  const candidates = LLM_PROVIDER_PRIORITY.filter((provider) => {
    if (provider === "gemma") return Boolean(GEMINI_API_KEY);
    if (provider === "groq") return Boolean(GROQ_API_KEY);
    return false;
  });

  if (!candidates.length) {
    throw new Error("No LLM provider is configured. Check your server/.env file.");
  }

  let lastErr;
  for (const provider of candidates) {
    try {
      return provider === "gemma" ? await callGemma(pitchText) : await callGroq(pitchText);
    } catch (err) {
      lastErr = err;
      console.warn(`LLM provider fallback: ${provider} failed: ${err.message}`);
    }
  }

  throw lastErr || new Error("No LLM provider succeeded.");
}

const clampScore = (n) => {
  const x = Math.round(Number(n));
  return Number.isFinite(x) ? Math.min(100, Math.max(0, x)) : 50;
};

const cleanText = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Parse + validate + normalize the LLM output into a predictable shape. */
function normalizeVerdictPayload(raw) {
  // Grab everything from the first "{" to the last "}" so code fences or stray text can't break parsing.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const cleaned = start !== -1 && end > start ? raw.slice(start, end + 1) : raw.trim();
  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed.judges)) throw new Error("`judges` is not an array");

  const judges = JUDGES.map((meta, idx) => {
    // Match by id, fall back to position
    const found =
      parsed.judges.find((j) => String(j.id).toLowerCase() === meta.id) ||
      parsed.judges[idx];
    if (!found) throw new Error(`Missing judge: ${meta.id}`);

    const critique = cleanText(found.critique);
    if (!critique) throw new Error(`Empty critique for ${meta.id}`);

    return {
      id: meta.id,
      name: meta.name,
      title: meta.title,
      critique,
      roast: cleanText(found.roast) || "No comment. Which is the comment.",
      score: clampScore(found.score),
    };
  });

  const v = parsed.verdict || {};
  const takeaways = (Array.isArray(v.takeaways) ? v.takeaways : [])
    .map(cleanText)
    .filter(Boolean)
    .slice(0, 3);
  while (takeaways.length < 3) takeaways.push("Sharpen the pitch and try again.");

  // Compute consensus from the actual judge scores so numbers never contradict each other.
  const avg = Math.round(judges.reduce((s, j) => s + j.score, 0) / judges.length);

  return {
    judges,
    verdict: {
      score: avg,
      ruling: cleanText(v.ruling).toUpperCase() || "CASE DISMISSED",
      takeaways,
    },
  };
}

/** Call the LLM, retrying once if the output fails validation. */
async function generateJudgements(pitchText) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await callLLM(pitchText);
      return normalizeVerdictPayload(raw);
    } catch (err) {
      lastErr = err;
      if (err.status) throw err; // don't retry HTTP errors (rate limits, bad key, etc.)
      console.warn(`Judgement attempt ${attempt} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────
// ElevenLabs
// ─────────────────────────────────────────────────────────────
async function synthesizeSpeech(judge, text) {
  const spoken = text.length > MAX_SPOKEN_CHARS ? text.slice(0, MAX_SPOKEN_CHARS).replace(/\s+\S*$/, "…") : text;

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${judge.voiceId}` +
    `?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: spoken,
      model_id: ELEVENLABS_MODEL,
      voice_settings: judge.voiceSettings,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 200)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return { mimeType: "audio/mpeg", base64: buffer.toString("base64") };
}

/**
 * Sequential on purpose: ElevenLabs' free tier allows very few concurrent requests,
 * and sequential order matches the on-screen debate order.
 * A TTS failure for one judge never kills the whole response.
 */
async function attachAudio(judges) {
  const out = [];
  for (const j of judges) {
    const meta = JUDGES.find((m) => m.id === j.id);
    try {
      const audio = await synthesizeSpeech(meta, j.critique);
      out.push({ ...j, audio, audioError: null });
    } catch (err) {
      console.error(`TTS failed for ${j.id}:`, err.message);
      out.push({ ...j, audio: null, audioError: "Voice unavailable for this judge." });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────
const app = express();
const DIST_DIR = path.join(__dirname, "..", "dist");

app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: "50kb" }));

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
}

app.get("/", (_req, res) => {
  if (fs.existsSync(path.join(DIST_DIR, "index.html"))) {
    return res.sendFile(path.join(DIST_DIR, "index.html"));
  }

  return res.json({
    ok: true,
    message: "Pitch Court API is running.",
    frontend: "Open http://localhost:5173 to use the app UI.",
    endpoints: {
      health: "/api/health",
      judge: "POST /api/judge",
    },
  });
});

// Tiny in-memory rate limiter (per IP) so a demo crowd can't drain your free quota.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_MIN || 6);
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    return res.status(429).json({ error: "The court is in recess. Try again in a minute." });
  }
  recent.push(now);
  hits.set(req.ip, recent);
  next();
}

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    provider: LLM_PROVIDER,
    model: LLM_MODEL,
    llmKey: Boolean(LLM_KEY),
    elevenLabsKey: Boolean(ELEVENLABS_API_KEY),
  })
);

app.post("/api/judge", rateLimit, async (req, res) => {
  const pitchText = typeof req.body?.pitchText === "string" ? req.body.pitchText.trim() : "";

  if (pitchText.length < MIN_PITCH_CHARS) {
    return res
      .status(400)
      .json({ error: `Pitch is too short. Give us at least ${MIN_PITCH_CHARS} characters.` });
  }
  if (pitchText.length > MAX_PITCH_CHARS) {
    return res
      .status(400)
      .json({ error: `Pitch is too long. Keep it under ${MAX_PITCH_CHARS} characters.` });
  }
  if (!LLM_KEY || !ELEVENLABS_API_KEY) {
    return res.status(500).json({ error: "Server is missing API keys. Check your .env file." });
  }

  try {
    const t0 = Date.now();
    const { judges, verdict } = await generateJudgements(pitchText);
    const tLLM = Date.now();

    const judgesWithAudio = await attachAudio(judges);
    const tTTS = Date.now();

    res.json({
      judges: judgesWithAudio,
      verdict,
      meta: {
        provider: LLM_PROVIDER,
        model: LLM_MODEL,
        llmMs: tLLM - t0,
        ttsMs: tTTS - tLLM,
        audioComplete: judgesWithAudio.every((j) => j.audio),
      },
    });
  } catch (err) {
    console.error("/api/judge failed:", err.message);
    const isLLMError = err.source === "groq" || err.source === "gemma";
    if (isLLMError && err.status === 429) {
      return res.status(503).json({ error: "The judges are overwhelmed (rate limit). Try again shortly." });
    }
    if (isLLMError && (err.status === 401 || err.status === 403)) {
      return res.status(500).json({ error: "The AI provider rejected the API key. Check your key in server/.env." });
    }
    if (isLLMError && (err.status === 400 || err.status === 404)) {
      return res.status(500).json({
        error: `The AI provider rejected the request (model "${LLM_MODEL}"). Check your API key and model name in server/.env.`,
      });
    }
    res.status(500).json({ error: "The court has collapsed. Please try again." });
  }
});

function startServer(port = PORT) {
  return app.listen(port, () => {
    console.log(`⚖️  Pitch Court backend listening on http://localhost:${port}`);
    console.log(`   LLM: ${LLM_PROVIDER} / ${LLM_MODEL} | TTS: ${ELEVENLABS_MODEL}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  generateJudgements,
  normalizeVerdictPayload,
};
