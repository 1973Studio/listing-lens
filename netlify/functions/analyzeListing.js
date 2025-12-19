// netlify/functions/analyzeListing.js
// Receives: { imageBase64: "...", mimeType: "image/png" }
// Returns: { data: { vehicle_title, lens_score, summary, market_value_estimate, red_flags, questions_to_ask } }

const OpenAI = require("openai");

function response(statusCode, bodyObj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      // Keep CORS open for MVP (tighten later)
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(bodyObj),
  };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// Ultra-defensive JSON extraction (models sometimes wrap JSON in text)
function extractJson(text) {
  if (!text) return null;

  // 1) direct parse
  try {
    return JSON.parse(text);
  } catch (_) {}

  // 2) find first {...} block
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = text.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }
  return null;
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") return response(200, { ok: true });

  if (event.httpMethod !== "POST") {
    return response(405, { error: "Method Not Allowed" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return response(500, { error: "Missing OPENAI_API_KEY in environment variables" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return response(400, { error: "Invalid JSON body" });
  }

  const imageBase64 = payload.imageBase64;
  const mimeType = payload.mimeType || "image/jpeg";

  if (!imageBase64 || typeof imageBase64 !== "string") {
    return response(400, { error: "imageBase64 is required" });
  }

  // Size guard (base64 can get huge)
  if (imageBase64.length > 12_000_000) {
    return response(413, { error: "Image too large. Use a smaller screenshot." });
  }

  const dataUrl = `data:${mimeType};base64,${imageBase64}`;

  const SYSTEM_PROMPT = `
You are Listing Lens — a brutally honest digital inspector for transport listings (cars, bikes, boats, caravans, trucks, machinery).

You ONLY have a screenshot. Do not invent facts you cannot see (VIN, service history, odometer if not visible, exact trim).
Be explicit about uncertainty. Your job is to protect the buyer from bad deals.

Return ONLY valid JSON with this schema:

{
  "vehicle_title": "string",
  "lens_score": number,                // 0-100
  "summary": "string",                 // 1-2 short sentences
  "market_value_estimate": "string",   // "$28k–$33k" or "Unknown"
  "red_flags": ["string", "..."],      // 0-8 items
  "questions_to_ask": ["string", "..."]// 3-8 items
}

Scoring rules:
- Start at 70.
- Subtract points for missing critical info, suspicious phrasing, visible wear/damage, inconsistencies, vague claims.
- Add points for strong positives (clear photos, detailed info, evidence, reputable signals).
- Keep lens_score realistic (0-100).

market_value_estimate:
- If the screenshot shows enough (year/model/variant, kms, price/location), give a broad range.
- Otherwise: "Unknown".

Style rules:
- Punchy. No essays.
- Red flags should be things you can infer from what you SEE or what is conspicuously missing.
`.trim();

  const USER_PROMPT = `Analyze this listing screenshot and output the JSON.`;

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Using Responses API with image input + forced JSON output.
    const resp = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: SYSTEM_PROMPT }],
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: USER_PROMPT },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
      // This strongly nudges valid JSON output
      text: { format: { type: "json_object" } },
    });

    // Most reliable accessor:
    const outText = resp.output_text || "";
    const report = extractJson(outText);

    if (!report) {
      return response(502, {
        error: "Model returned non-JSON output",
        raw: outText.slice(0, 2000),
      });
    }

    // Normalize + guardrails
    const cleaned = {
      vehicle_title: (report.vehicle_title || "Unknown Vehicle").toString().slice(0, 120),
      lens_score: clamp(Number(report.lens_score) || 50, 0, 100),
      summary: (report.summary || "No summary returned.").toString().slice(0, 500),
      market_value_estimate: (report.market_value_estimate || "Unknown").toString().slice(0, 80),
      red_flags: Array.isArray(report.red_flags) ? report.red_flags.map(String).slice(0, 8) : [],
      questions_to_ask: Array.isArray(report.questions_to_ask)
        ? report.questions_to_ask.map(String).slice(0, 8)
        : [],
    };

    // Ensure questions_to_ask has at least 3 items (MVP UX)
    if (cleaned.questions_to_ask.length < 3) {
      cleaned.questions_to_ask = cleaned.questions_to_ask.concat([
        "Can you confirm the service history and provide receipts/logbook photos?",
        "Any accidents, repairs, paintwork, flood/hail damage, or insurance claims?",
        "Is there finance owing, and can we do a PPSR check / clear title confirmation?",
      ]).slice(0, 8);
    }

    return response(200, { data: cleaned });
  } catch (err) {
    console.error("OpenAI error:", err);
    return response(500, {
      error: "Analysis failed",
      message: err?.message || String(err),
    });
  }
};
