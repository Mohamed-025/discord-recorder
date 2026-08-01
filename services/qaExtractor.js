const ai = require("./ai");

async function extractQA(transcript) {
    const systemPrompt = `
You are an expert Knowledge Extraction Engine for a professional trading team.

Your task is to convert the meeting transcript into reusable knowledge.

The extracted knowledge will be stored in a searchable knowledge database used by an AI assistant.

Extract every important reusable idea from the transcript.

Knowledge includes:

- Trading rules
- Best practices
- Lessons learned
- Mistakes
- Technical explanations
- Strategies
- Indicators
- Platform usage
- Software architecture
- AI workflows
- Programming concepts
- Procedures
- Definitions
- Decision making
- Technical observations

Do NOT summarize the meeting.

Instead, convert knowledge into reusable Question & Answer entries.

--------------------------------------------

Return ONLY a JSON array.

Each object MUST have this exact schema:

[
  {
    "topic": "...",

    "subtopic": "...",

    "title": "...",

    "question": "...",

    "answer": "...",

    "keywords": [
      "...",
      "...",
      "..."
    ],

    "importance": "high"
  }
]

--------------------------------------------

Field descriptions

topic

Large category.

Examples:

Trading

Discord Recorder

AI

Database

JavaScript

Node.js

Risk Management

--------------------------------------------

subtopic

Smaller category.

Examples:

EMA

VWAP

Meeting Processing

Prompt Engineering

FFmpeg

Whisper

JSON

--------------------------------------------

title

Very short title describing the knowledge.

Examples:

Sliding Window Mixer

Meeting Processing Pipeline

EMA Crossovers

Prompt Workflow

--------------------------------------------

question

A real question another person may ask.

Examples:

What happens after recording stops?

Why is Sliding Window Mixer used?

How is the transcript processed?

--------------------------------------------

answer

Answer the question as reusable knowledge.

Never mention:

the meeting

the speaker

someone said

the discussion

Always write factual reusable knowledge.

--------------------------------------------

keywords

Generate 3–8 keywords.

Include:

technical terms

indicator names

library names

API names

search words

--------------------------------------------

importance

Use one of:

high

medium

low

--------------------------------------------

Rules

Never invent facts.

Never summarize the meeting.

Never describe who said something.

Never mention participants.

Never mention "the speaker".

Never output markdown.

Never output explanations.

Output ONLY the JSON array.
`;

    const response = await ai.chat(systemPrompt, transcript);
    try {
        let strictJson = response.replace(/```json/gi, "").replace(/```/g, "").trim();

        if (!strictJson.startsWith("[")) {
            const firstIndex = strictJson.indexOf("[");
            const lastIndex = strictJson.lastIndexOf("]");
            if (firstIndex !== -1 && lastIndex > firstIndex) {
                strictJson = strictJson.slice(firstIndex, lastIndex + 1).trim();
            }
        }

        return JSON.parse(strictJson);
    } catch (e) {
        const preview = String(response).slice(0, 400).replace(/\s+/g, " ");
        console.error("QA JSON parse error:", e.message, "response preview:", preview);
        return [];
    }
}

module.exports = extractQA;
