const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const aiPath = require.resolve("../services/ai");
const cleanTranscriptPath = require.resolve("../services/cleanTranscript");
const summarizerPath = require.resolve("../services/summarizer");

require.cache[aiPath] = {
    id: aiPath,
    filename: aiPath,
    loaded: true,
    exports: {
        transcribe: async () => ({ text: "Hello team. This is the first point.\n\nSecond point." }),
        chat: async () => "[]",
    },
};

require.cache[cleanTranscriptPath] = {
    id: cleanTranscriptPath,
    filename: cleanTranscriptPath,
    loaded: true,
    exports: async (text) => text,
};

require.cache[summarizerPath] = {
    id: summarizerPath,
    filename: summarizerPath,
    loaded: true,
    exports: async (text) => `Summary for: ${text}`,
};

const meetingProcessor = require("../services/meetingProcessor");

(async () => {
    const result = await meetingProcessor.process("dummy.mp3");
    assert.ok(result.cleanedTranscript.includes("Speaker:"));
    assert.ok(result.summary.includes("Summary for"));

    delete require.cache[require.resolve("../services/meetingProcessor")];
    require.cache[aiPath] = {
        id: aiPath,
        filename: aiPath,
        loaded: true,
        exports: {
            transcribe: async () => {
                throw new Error("transcription failed");
            },
            chat: async () => "",
        },
    };

    const fallbackProcessor = require("../services/meetingProcessor");
    const fallbackResult = await fallbackProcessor.process("dummy.mp3");
    assert.ok(fallbackResult.summary.includes("Processing failed"));

    delete require.cache[require.resolve("../services/meetingProcessor")];
    process.env.AI_TIMEOUT_MS = "150";
    require.cache[aiPath] = {
        id: aiPath,
        filename: aiPath,
        loaded: true,
        exports: {
            transcribe: async () => new Promise(() => { }),
            chat: async () => "",
        },
    };

    const hangingProcessor = require("../services/meetingProcessor");
    const hangingResult = await Promise.race([
        hangingProcessor.process("dummy.mp3"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 500)),
    ]);
    assert.ok(hangingResult.fallback === true);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-"));
    const outputPaths = await fallbackProcessor.saveOutputs(tempDir, fallbackResult);

    assert.ok(fs.existsSync(outputPaths.transcriptPath));
    assert.ok(fs.existsSync(outputPaths.summaryPath));

    console.log("meetingProcessor regression test passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
