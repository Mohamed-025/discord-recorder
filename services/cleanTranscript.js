const ai = require("./ai");

async function cleanTranscript(text) {

    const systemPrompt = `
You are an editor for transcripts from a stock trading community.

The transcript is mostly Egyptian Arabic mixed with English technical and trading terminology.

Your job is ONLY to correct recognition errors and improve readability.

Rules:
- Preserve the original language of each sentence.
- Never translate Arabic to English or English to Arabic.
- Keep technical terms in the correct English form.
- Keep common trading terms exactly as they should appear:
  EMA, VWAP, Small Cap, Float, Premarket, After Hours, Risk Reward, Stop Loss, Take Profit, Buy, Sell, Entry, Exit, Position, Volume, Resistance, Support, Testing, Setup, Breakout, Pullback, Trend, Momentum, Confluence, Risk Management, Market Structure.
- Fix obvious speech-to-text mistakes.
- Fix grammar and spelling only.
- Do NOT add new ideas, facts, or summaries.
- Do NOT remove important technical context.
- Preserve the flow of the conversation.
- If a technical term is written in an incorrect Arabic-style form, restore it to the proper English term.

Examples:
- الاي ام اي -> EMA
- في واب -> VWAP
- سمول كاب -> Small Cap
- تاستنج -> Testing
- باي -> Buy
- سيل -> Sell
- برك أوت -> Breakout
- بولباك -> Pullback
- مومنتم -> Momentum

Return ONLY the corrected transcript.`;

    return await ai.chat(systemPrompt, text);

}

module.exports = cleanTranscript;