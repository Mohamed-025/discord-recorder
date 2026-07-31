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
            language: "ar",
            prompt: "The following is a meeting transcript. The speakers are conversing in Arabic and English.",
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