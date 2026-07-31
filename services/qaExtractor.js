const ai = require("./ai");

async function extractQA(transcript) {
    const systemPrompt = `
You are an expert Q&A data extractor for a technical trading team.

Based on the meeting transcript provided, extract ALL trading-related questions, answers, discussion points, setups, and insights.
Identify the overarching core Topic for each Q&A pair (e.g. "Risk Management", "Trading Platforms", "Entry Strategies", "Psychology").

You MUST return the data in a raw JSON array format matching this exact schema:
[
  {
    "topic": "The Topic Headline",
    "question": "The question, issue, or concept discussed?",
    "answer": "The comprehensive answer or conclusion from the transcript."
  }
]

CRITICAL: Return ONLY valid JSON array. No markdown backticks, no explanations, no text before or after the array.
Do not hallucinate data. Keep technical formatting intact.
`;

    const response = await ai.chat(systemPrompt, transcript);
    try {
        const strictJson = response.replace(/```json/gi, "").replace(/```/g, "").trim();
        return JSON.parse(strictJson);
    } catch (e) {
        console.error("QA JSON parse error:", e.message);
        return [];
    }
}

module.exports = extractQA;
