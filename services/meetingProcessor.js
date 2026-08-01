const fs = require("fs");
const path = require("path");
const ai = require("./ai");
const cleanTranscript = require("./cleanTranscript");
const summarize = require("./summarizer");
const extractQA = require("./qaExtractor");

const crypto = require("crypto");

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
    if (!text || !text.trim()) {
        return text;
    }

    return text
        .split(/\n\n+/)
        .map((paragraph) => {
            const trimmed = paragraph.trim();
            if (!trimmed) return "";
            return `Speaker: ${trimmed}`;
        })
        .filter(Boolean)
        .join("\n\n");
}

function resolveMp3Files(meetingFolder) {
    const normalized = String(meetingFolder || "").trim();
    if (!normalized) {
        throw new Error("Meeting folder path is required.");
    }

    if (normalized.toLowerCase().endsWith(".mp3")) {
        return [normalized];
    }

    const resolvedPath = path.resolve(normalized);
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Meeting folder does not exist: ${resolvedPath}`);
    }

    const stats = fs.statSync(resolvedPath);
    if (stats.isFile()) {
        if (!resolvedPath.toLowerCase().endsWith(".mp3")) {
            throw new Error("Meeting file must be an .mp3 file.");
        }
        return [resolvedPath];
    }

    const files = fs.readdirSync(resolvedPath)
        .filter((f) => f.toLowerCase().endsWith(".mp3"))
        .sort()
        .map((f) => path.join(resolvedPath, f));

    if (!files.length) {
        throw new Error(`No .mp3 files found in directory: ${resolvedPath}`);
    }

    return files;
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

            const mp3Files = resolveMp3Files(meetingFolder);

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

            const cleanedTranscript = addSpeakerLabels(cleanedParts.join("\n\n"));

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
        if (!meetingFolder || typeof meetingFolder !== "string") {
            throw new Error("Invalid meeting folder path.");
        }

        const resolvedPath = path.resolve(meetingFolder);
        if (fs.existsSync(resolvedPath)) {
            const stats = fs.statSync(resolvedPath);
            if (!stats.isDirectory()) {
                throw new Error(`Expected a meeting folder, but found a file: ${resolvedPath}`);
            }
        } else {
            fs.mkdirSync(resolvedPath, { recursive: true });
        }

        const transcriptPath = path.join(resolvedPath, "transcript.txt");
        const summaryPath = path.join(resolvedPath, "summary.md");

        fs.writeFileSync(transcriptPath, result.cleanedTranscript || "Empty Transcript", "utf8");
        fs.writeFileSync(summaryPath, result.summary || "Empty Summary", "utf8");

        // Sync Q&A Data dynamically
        if (result.qaData && Array.isArray(result.qaData)) {
            const dbPath = path.join(__dirname, "..", "database.json");
            let existingDb = {
                version: 1,
                meetings: [],
                qa: []
            };

            if (fs.existsSync(dbPath)) {
                try {
                    existingDb = JSON.parse(fs.readFileSync(dbPath, "utf8"));

                    // حماية لو الملف قديم أو ناقص
                    existingDb.version ??= 1;
                    existingDb.meetings ??= [];
                    existingDb.qa ??= [];

                } catch (e) {
                    console.error("Could not parse existing database", e);
                }
            }
            const meetingId = path.basename(meetingFolder);

            const meetingInfo = {
                id: meetingId,
                title: meetingId,
                createdAt: new Date().toISOString(),
                transcriptFile: transcriptPath,
                summaryFile: summaryPath,
            };

            const qaItems = Array.isArray(result.qaData)
                ? result.qaData
                : [];


            const augmentedQA = qaItems.map(qa => ({
                id: crypto.randomUUID(),
                meetingId,
                createdAt: new Date().toISOString(),
                ...qa
            }));

            

            // أضف الاجتماع مرة واحدة فقط
            if (!existingDb.meetings.some(m => m.id === meetingId)) {
                existingDb.meetings.push(meetingInfo);
            }

            // أضف الـ Q&A
            existingDb.qa.push(...augmentedQA);

            fs.writeFileSync(
                dbPath,
                JSON.stringify(existingDb, null, 2),
                "utf8"
            );

            console.log(
                `Database updated successfully. Meetings: ${existingDb.meetings.length}, Q&A: ${existingDb.qa.length}`
            );
        }

        return {
            transcriptPath,
            summaryPath,
        };
    }
};