const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { initializeApp } = require("firebase-admin/app");

initializeApp();

// 🔑 API Key (Hardcoded for V1 stability)
const genAI = new GoogleGenerativeAI("AIzaSyAedFuMwj5e0UQk8D4tziC7LVwL0ECE-q0");

const SYSTEM_PROMPT = `
  You are Listing Lens (The Viking Engine). You are the "Universal Truth Layer" for transport listings.
  
  ### PHASE 1: CLASSIFICATION
  Analyze the provided image(s). If multiple images are provided, combine the visual data to form a complete picture.
  Determine the VEHICLE TYPE (Car, Bike, Boat, Truck, etc).

  ### PHASE 2: ANALYSIS PROTOCOL
  Activate the "Skeptical Master Mechanic & Dealer Principal" persona.
  1. EXTRACT: Year, Make, Model, Trim, Price, Odometer.
  2. DECODE: Translate dealer fluff.
  3. MATCH FAULTS: Cross-reference Model Year with known mechanical failures.
  4. VALUE CHECK: Compare Price vs Odometer/Condition.
  5. DETECT RISKS: Look for panel gaps, modifications, wear, or missing service history clues across ALL images.

  ### PHASE 3: OUTPUT FORMAT (STRICT JSON)
  Return ONLY valid JSON. No markdown.
  {
    "vehicle_title": "Year Make Model Trim",
    "lens_score": 0-100, (Integer),
    "summary": "A brutal, 2-sentence summary of the truth.",
    "market_value_estimate": "$XX,XXX - $XX,XXX",
    "red_flags": ["Risk 1", "Visual defect 2", "Missing history"],
    "mechanic_questions": ["Question 1", "Question 2"]
  }
`;

exports.analyzeListing = onCall({ cors: true, timeoutSeconds: 60 }, async (request) => {
  // Support both single image (legacy) and array (dashboard)
  let images = [];
  
  if (request.data.images) {
    images = request.data.images; // Array of base64 strings
  } else if (request.data.imageBase64) {
    images = [request.data.imageBase64]; // Single image fallback
  } else {
    throw new HttpsError('invalid-argument', 'Image data missing.');
  }

  try {
    // 🛠️ Using the verified model name "gemini-2.5-flash"
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    // Construct the payload with multiple images
    const contentParts = [{ text: SYSTEM_PROMPT }];
    
    images.forEach(base64 => {
        contentParts.push({ inlineData: { data: base64, mimeType: "image/jpeg" } });
    });

    const result = await model.generateContent([
        { role: "user", parts: contentParts }
    ]);

    const response = await result.response;
    const text = response.text();
    const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
    
    return { success: true, data: JSON.parse(jsonStr) };

  } catch (error) {
    console.error("AI Error:", error);
    throw new HttpsError('internal', "Gemini Error: " + error.message);
  }
});