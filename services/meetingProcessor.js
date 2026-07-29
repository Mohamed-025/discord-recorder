const fs = require("fs");
const path = require("path");
const ai = require("./ai");
const cleanTranscript = require("./cleanTranscript");
const summarize = require("./summarizer");

const MAX_TRANSCRIPT_CHARS = 18000;

function splitTranscript(text, maxChars = MAX_TRANSCRIPT_CHARS) {
    if (text.length <= maxChars) {
        return [text];
    }

    const parts = [];
    let current = "";
    for (const paragraph of text.split(/\n\n+/)) {
        if (!paragraph.trim()) continue;
        if ((current + "\n\n" + paragraph).trim().length > maxChars) {
            if (current.trim()) parts.push(current.trim());
            current = paragraph;
        } else {
            current = current ? `${current}\n\n${paragraph}` : paragraph;
        }
    }

    if (current.trim()) parts.push(current.trim());
    return parts;
}

function addSpeakerLabels(text) {
    return text
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `Speaker: ${line}`)
        .join("\n");
}

function buildFallbackResult(filePath, error) {
    const message = error?.message || String(error);
    const fallbackTranscript = `Transcript unavailable.\n\nError: ${message}`;
    const fallbackSummary = [
        "# Meeting Summary",
        "",
        "## Main Topics",
        "- Processing failed.",
        "",
        "## Decisions",
        "- None.",
        "",
        "## Action Items",
        "- [ ] Re-run processing for the recording.",
        "",
        "## Important Notes",
        `- Audio file: ${path.basename(filePath)}`,
        `- Error: ${message}`,
    ].join("\n");

    return {
        transcription: null,
        cleanedTranscript: addSpeakerLabels(fallbackTranscript),
        summary: fallbackSummary,
        transcriptChunks: [],
        error: message,
        fallback: true,
    };
}

module.exports = {
    async process(filePath, options = {}) {
        console.log("🎙️ Starting meeting processing...");

        const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 60000);

        try {
            console.log("1️⃣ Transcribing...");
            const transcription = await Promise.race([
                ai.transcribe(filePath),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Processing timed out after ${timeoutMs}ms`)), timeoutMs)),
            ]);

            const transcriptText = transcription?.text || "";
            const cleanedParts = [];

            console.log("2️⃣ Cleaning transcript...");
            const chunks = splitTranscript(transcriptText);
            for (const chunk of chunks) {
                const cleanedChunk = await cleanTranscript(chunk);
                cleanedParts.push(cleanedChunk.trim());
            }

            const cleanedTranscript = cleanedParts.join("\n\n");

            console.log("3️⃣ Generating summary...");
            const summary = await summarize(cleanedTranscript);

            const labeledTranscript = addSpeakerLabels(cleanedTranscript);

            return {
                transcription,
                cleanedTranscript: labeledTranscript,
                summary,
                transcriptChunks: cleanedParts,
            };
        } catch (error) {
            console.error("⚠️ Meeting processing failed:", error);
            return buildFallbackResult(filePath, error);
        }
    },

    async saveOutputs(meetingFolder, result) {
        fs.mkdirSync(meetingFolder, { recursive: true });
        fs.writeFileSync(path.join(meetingFolder, "transcript.txt"), result.cleanedTranscript, "utf8");
        fs.writeFileSync(path.join(meetingFolder, "summary.md"), result.summary, "utf8");
        return {
            transcriptPath: path.join(meetingFolder, "transcript.txt"),
            summaryPath: path.join(meetingFolder, "summary.md"),
        };
    },

    async buildDiscordPayload(result, meetingFilePath) {
        const summaryText = result.summary || "No summary generated.";
        const fileName = path.basename(meetingFilePath);
        return {
            content: `✅ Meeting finished successfully.\n\n📄 Audio file: ${fileName}\n\n# 📋 Meeting Summary\n\n${summaryText}`,
        };
    }
};