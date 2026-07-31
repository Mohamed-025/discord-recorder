const fs = require("fs");
const path = require("path");
const ai = require("./ai");
const cleanTranscript = require("./cleanTranscript");
const summarize = require("./summarizer");
const extractQA = require("./qaExtractor");

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
    // Labels are generic since voices are mixed
    return text;
}

function buildFallbackResult(meetingFolder, error) {
    const message = error?.message || String(error);
    const fallbackTranscript = `Transcript unavailable.\n\nError: ${message}`;
    const fallbackSummary = [
        "# Meeting Summary",
        "",
        "## Main Topics",
        "- Processing failed.",
        "",
        "## Important Notes",
        `- Error: ${message}`,
    ].join("\n");

    return {
        transcription: null,
        cleanedTranscript: fallbackTranscript,
        summary: fallbackSummary,
        transcriptChunks: [],
        error: message,
        qaData: [],
        fallback: true,
    };
}

module.exports = {
    async process(meetingFolder, options = {}) {
        console.log("🎙️ Starting meeting processing on ID:", path.basename(meetingFolder));

        const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 90000);

        try {
            console.log("1️⃣ Transcribing Segments...");

            const files = fs.readdirSync(meetingFolder);
            const mp3Files = files.filter(f => f.endsWith(".mp3")).sort().map(f => path.join(meetingFolder, f));

            let fullTranscriptText = "";
            let fullTranscriptionObject = null;

            for (const mp3 of mp3Files) {
                console.log(`Transcribing segment: ${path.basename(mp3)}`);
                const transcription = await Promise.race([
                    ai.transcribe(mp3),
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`Segment processing timed out`)), timeoutMs)),
                ]);
                fullTranscriptText += (transcription?.text || "") + " ";
                if (!fullTranscriptionObject) fullTranscriptionObject = transcription;
            }

            const cleanedParts = [];

            console.log("2️⃣ Cleaning transcript...");
            const chunks = splitTranscript(fullTranscriptText);
            for (const chunk of chunks) {
                const cleanedChunk = await cleanTranscript(chunk);
                cleanedParts.push(cleanedChunk.trim());
            }

            const cleanedTranscript = cleanedParts.join("\n\n");

            console.log("3️⃣ Generating summary...");
            const summary = await summarize(cleanedTranscript);

            console.log("4️⃣ Extracting Q&A Database Entries...");
            const qaData = await extractQA(cleanedTranscript);

            return {
                transcription: fullTranscriptionObject,
                cleanedTranscript,
                summary,
                qaData,
                transcriptChunks: cleanedParts,
                meetingFiles: mp3Files
            };
        } catch (error) {
            console.error("⚠️ Meeting processing failed:", error);
            return buildFallbackResult(meetingFolder, error);
        }
    },

    async saveOutputs(meetingFolder, result) {
        fs.mkdirSync(meetingFolder, { recursive: true });

        const transcriptPath = path.join(meetingFolder, "transcript.txt");
        const summaryPath = path.join(meetingFolder, "summary.md");

        fs.writeFileSync(transcriptPath, result.cleanedTranscript || "Empty Transcript", "utf8");
        fs.writeFileSync(summaryPath, result.summary || "Empty Summary", "utf8");

        // Sync Q&A Data dynamically
        if (result.qaData && Array.isArray(result.qaData)) {
            const dbPath = path.join(__dirname, "..", "database.json");
            let existingDb = [];
            if (fs.existsSync(dbPath)) {
                try {
                    existingDb = JSON.parse(fs.readFileSync(dbPath, "utf8"));
                } catch (e) { console.error("Could not parse existing database", e); }
            }
            const augmentedQA = result.qaData.map(qa => ({
                ...qa,
                meetingId: path.basename(meetingFolder),
                timestamp: Date.now()
            }));
            const updatedDb = existingDb.concat(augmentedQA);
            fs.writeFileSync(dbPath, JSON.stringify(updatedDb, null, 2), "utf8");
        }

        return {
            transcriptPath,
            summaryPath,
        };
    }
};