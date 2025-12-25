// Receives: { imagesBase64: ["...", "..."] }
// Returns: same JSON fields your frontend already expects

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return response(200, { ok: true });
  if (event.httpMethod !== "POST") return response(405, { error: "Method Not Allowed" });
  if (!process.env.OPENAI_API_KEY) return response(500, { error: "Missing OPENAI_API_KEY" });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return response(400, { error: "Invalid JSON body" });
  }

  const imagesBase64 = payload.imagesBase64;

  // --- VALIDATION ---
  if (!Array.isArray(imagesBase64) || imagesBase64.length === 0) {
    return response(400, { error: "imagesBase64 must be a non-empty array" });
  }
  if (imagesBase64.length > 4) {
    return response(400, { error: "Maximum 4 images allowed" });
  }

  // size guard per image
  for (const img of imagesBase64) {
    if (typeof img !== "string") {
      return response(400, { error: "All images must be base64 strings" });
    }
    if (img.length > 12_000_000) {
      return response(413, { error: "One of the images is too large." });
    }
  }

  const SYSTEM_PROMPT = `... (keep your existing one unchanged) ...`;

  const USER_PROMPT = `
You are given 1–4 screenshots of the SAME listing.

Use ALL screenshots together to extract details and judge risk.
Be honest, blunt, and do NOT invent facts you cannot see.

Return ONLY valid JSON using the schema you were shown.
  `.trim();

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // build multimodal input — ALL IMAGES
    const input = [
      { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
      {
        role: "user",
        content: [
          { type: "input_text", text: USER_PROMPT },
          ...imagesBase64.map((b64) => ({
            type: "input_image",
            image_url: `data:image/jpeg;base64,${b64}`,
          })),
        ],
      },
    ];

    const resp = await client.responses.create({
      model: "gpt-4.1-mini",
      input,
      text: { format: { type: "json_object" } },
    });

    const outText = resp.output_text || "";
    const report = extractJson(outText);

    if (!report) {
      return response(502, { error: "Model returned non-JSON output", raw: outText.slice(0, 2000) });
    }

    // (keep your normalization block below exactly as-is)
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
    return response(500, { error: "Analysis failed", message: err?.message || String(err) });
  }
};
