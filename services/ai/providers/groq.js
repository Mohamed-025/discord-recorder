const OpenAI = require("openai");
const fs = require("fs");

const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
});

module.exports = {

    async transcribe(filePath) {

        const fs = require("fs");

        const transcription = await client.audio.transcriptions.create({
            file: fs.createReadStream(filePath),
            model: "whisper-large-v3-turbo",
            response_format: "verbose_json",
            temperature: 0,
            prompt: `Transcribe the audio exactly as spoken.

Do NOT translate.

Keep Arabic in Arabic.

Keep English in English.

Preserve names, numbers, trading terms, abbreviations, and mixed-language sentences exactly as spoken.`,
        });

        return transcription;

    },

    async chat(systemPrompt, userPrompt) {

        const response = await client.chat.completions.create({

            model: "llama-3.3-70b-versatile",

            messages: [

                {
                    role: "system",
                    content: systemPrompt,
                },

                {
                    role: "user",
                    content: userPrompt,
                },

            ],

            temperature: 0,

        });

        return response.choices[0].message.content;

    },

    async summarize(text) {

        throw new Error("Not implemented yet");

    }

};