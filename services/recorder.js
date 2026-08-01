const { spawn } = require("child_process");
const { EndBehaviorType } = require("@discordjs/voice");
const fs = require("fs");
const path = require("path");
const prism = require("prism-media");
const SlidingWindowMixer = require("./mixer");
const ffmpegPath = require("ffmpeg-static");

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const SILENCE_END_MS = 1200;
const AUDIO_DEBUG = process.env.DEBUG_AUDIO === "true";

function logEvent(session, message, details = {}) {
    const sessionId = session?.recordingSessionId || "n/a";
    console.log(`[recorder:${sessionId}] ${message}`, details);
}

function logError(session, message, error, details = {}) {
    const sessionId = session?.recordingSessionId || "n/a";
    console.error(`[recorder:${sessionId}] ${message}`, {
        error: error?.message || String(error),
        ...details,
    });
}

function audioLog(session, message, details = {}) {
    if (!AUDIO_DEBUG) return;
    const sessionId = session?.recordingSessionId || "n/a";
    console.log(`[audio:${sessionId}] ${message}`, details);
}

function ensureDirectory(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        fs.mkdirSync(directoryPath, { recursive: true });
        return;
    }

    if (!fs.statSync(directoryPath).isDirectory()) {
        throw new Error(`Expected a directory but found a file: ${directoryPath}`);
    }
}

function createMeetingFolder() {
    const meetingFolder = `meeting_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const meetingPath = path.join(__dirname, "..", "recordings", meetingFolder);
    ensureDirectory(meetingPath);
    return { meetingFolder, meetingPath };
}

function createFfmpegRecorder(outputFilePath) {
    const args = [
        "-y",
        "-f",
        "s16le",
        "-ar",
        String(SAMPLE_RATE),
        "-ac",
        String(CHANNELS),
        "-i",
        "pipe:0",
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "128k",
        outputFilePath,
    ];

    const ffmpeg = spawn(ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";

    ffmpeg.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
    });

    const exitPromise = new Promise((resolve, reject) => {
        ffmpeg.once("error", (error) => {
            reject(new Error(`FFmpeg failed to start: ${error.message}`));
        });

        ffmpeg.once("close", (code) => {
            if (code !== 0) {
                reject(new Error(`FFmpeg exited with code ${code}: ${stderr.trim()}`));
                return;
            }
            resolve();
        });
    });

    return { ffmpeg, exitPromise };
}

function waitForFileReady(filePath, timeoutMs = 10000, intervalMs = 250) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;

        const check = () => {
            try {
                if (fs.existsSync(filePath)) {
                    const stats = fs.statSync(filePath);
                    if (stats.size > 0) {
                        fs.accessSync(filePath, fs.constants.R_OK);
                        resolve(filePath);
                        return;
                    }
                }
            } catch (_) {
                // Retry until deadline.
            }

            if (Date.now() >= deadline) {
                reject(new Error(`Audio file was not ready in time: ${filePath}`));
                return;
            }

            setTimeout(check, intervalMs);
        };

        check();
    });
}

async function getAudioDuration(filePath) {
    const ffprobeExecutable = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
    const ffprobeCandidates = [
        path.join(path.dirname(ffmpegPath), ffprobeExecutable),
        ffprobeExecutable,
    ];

    let ffprobePath = null;
    for (const candidate of ffprobeCandidates) {
        if (candidate === ffprobeExecutable) {
            ffprobePath = candidate;
            break;
        }
        if (fs.existsSync(candidate)) {
            ffprobePath = candidate;
            break;
        }
    }

    const fallbackDuration = () => {
        try {
            const stats = fs.statSync(filePath);
            if (!stats || stats.size <= 0) {
                return 0;
            }
            // approximate MP3 duration with 128kbps bitrate
            return Number((stats.size * 8) / (128 * 1000));
        } catch (_error) {
            return 0;
        }
    };

    if (!ffprobePath) {
        return fallbackDuration();
    }

    const ffprobe = spawn(
        ffprobePath,
        [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            filePath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
    );

    return new Promise((resolve) => {
        let output = "";
        ffprobe.stdout.on("data", (chunk) => {
            output += chunk.toString();
        });
        ffprobe.stderr.on("data", () => { });
        ffprobe.once("close", () => {
            const duration = Number(output.trim());
            resolve(Number.isFinite(duration) ? duration : fallbackDuration());
        });
        ffprobe.once("error", () => resolve(fallbackDuration()));
    });
}

function createUserRecorder(session, receiver, mixer, userId) {
    const existing = session.activeUsers.get(userId);
    if (existing && existing.state === "active") {
        return existing;
    }

    const userState = {
        userId,
        cleanup: () => { },
        finished: Promise.resolve(),
        state: "initializing",
    };
    session.activeUsers.set(userId, userState);
    audioLog(session, "stream subscribed", { userId, activeUsers: session.activeUsers.size });
    let opusStream;
    try {
        opusStream = receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: SILENCE_END_MS,
            },
        });
    } catch (error) {
        audioLog(session, "user subscribe failed", { userId, error: error?.message });
        session.activeUsers.delete(userId);
        throw error;
    }

    const decoder = new prism.opus.Decoder({
        rate: SAMPLE_RATE,
        channels: CHANNELS,
        frameSize: 960,
    });

    ensureDirectory(session.meetingPath);

    let finished = false;
    let resolveCompletion;
    const completion = new Promise((resolve) => {
        resolveCompletion = resolve;
    });

    userState.firstPcmLogged = false;
    let firstChunkElapsedMs = null;
    let sampleOffset = 0;

    const onOpusData = (chunk) => {
        if (decoder.destroyed) {
            return;
        }
        if (!userState.firstPcmLogged) {
            userState.firstPcmLogged = true;
            audioLog(session, "first PCM received", { userId, elapsedMs: Date.now() - session.recordingStartTime });
        }
        try {
            decoder.write(chunk);
        } catch (error) {
            onStreamError(error);
        }
    };

    const onDecoderData = (chunk) => {
        if (chunk.length === 0) {
            return;
        }

        if (firstChunkElapsedMs === null) {
            firstChunkElapsedMs = Date.now() - session.recordingStartTime;
        }

        const frameCount = chunk.length / (CHANNELS * 2);
        const elapsedMs = firstChunkElapsedMs + (sampleOffset / SAMPLE_RATE) * 1000;
        sampleOffset += frameCount;

        try {
            mixer.writeChunk(elapsedMs, chunk);
            audioLog(session, "mixer write", { userId, elapsedMs, byteLength: chunk.length, frameCount });
        } catch (error) {
            onStreamError(error);
        }
    };

    const onDecoderError = (error) => {
        audioLog(session, "decoder error", { userId, error: error?.message });
        logError(session, "Decoder error", error, { userId });
        cleanup();
    };

    const onDecoderEnd = () => {
        decoderEnded = true;
        audioLog(session, "decoder ended", { userId, elapsedMs: Date.now() - session.recordingStartTime });
        if (userState.state === "stopping") {
            finalizeCleanup();
        }
    };

    const onStreamError = (error) => {
        audioLog(session, "stream error", { userId, code: error?.code, message: error?.message });
        if (error?.code === "ERR_STREAM_DESTROYED" || error?.code === "ERR_STREAM_PREMATURE_CLOSE") {
            cleanup();
            return;
        }
        logError(session, "User stream error", error, { userId });
        cleanup();
    };

    let streamEnded = false;
    let decoderEnded = false;

    const finalizeCleanup = () => {
        if (finished) {
            if (resolveCompletion) resolveCompletion();
            return;
        }
        finished = true;
        userState.state = "done";

        try {
            decoder.off("data", onDecoderData);
            decoder.off("error", onDecoderError);
            decoder.off("end", onDecoderEnd);
        } catch (error) {
            logError(session, "Failed to remove decoder listeners", error, { userId });
        }

        try {
            if (!decoder.destroyed) {
                decoder.destroy();
            }
        } catch (error) {
            logError(session, "Failed to destroy decoder", error, { userId });
        }

        audioLog(session, "stream destroyed", { userId, bufferedMs: mixer.getBufferedTimeMs?.(), activeUsers: session.activeUsers.size });
        session.activeUsers.delete(userId);
        if (resolveCompletion) resolveCompletion();
    };

    const cleanup = () => {
        if (userState.state === "stopping" || userState.state === "done") {
            return;
        }
        userState.state = "stopping";

        audioLog(session, "cleanup requested", { userId, bufferedMs: mixer.getBufferedTimeMs?.(), activeUsers: session.activeUsers.size });

        try {
            opusStream.off("data", onOpusData);
            opusStream.off("end", onOpusEnd);
            opusStream.off("error", onStreamError);
        } catch (error) {
            logError(session, "Failed to remove voice listeners", error, { userId });
        }

        try {
            if (!opusStream.destroyed) {
                opusStream.destroy();
            }
        } catch (error) {
            logError(session, "Failed to destroy opus stream", error, { userId });
        }

        if (!decoder.destroyed && !decoder.writableEnded) {
            audioLog(session, "decoder end requested", { userId });
            try {
                decoder.end();
            } catch (error) {
                logError(session, "Failed to end decoder", error, { userId });
            }
        }

        if (decoderEnded) {
            finalizeCleanup();
        }
    };

    const onOpusEnd = () => {
        if (streamEnded) return;
        streamEnded = true;
        audioLog(session, "opus stream ended", { userId, elapsedMs: Date.now() - session.recordingStartTime });
        cleanup();
    };

    opusStream.on("data", onOpusData);
    opusStream.on("end", onOpusEnd);
    opusStream.on("error", onStreamError);

    decoder.on("data", onDecoderData);
    decoder.on("error", onDecoderError);
    decoder.on("end", onDecoderEnd);

    userState.cleanup = cleanup;
    userState.finished = completion;
    userState.state = "active";

    logEvent(session, "User subscribed", { userId });

    return session.activeUsers.get(userId);
}

module.exports = {
    async start(session) {
        if (session.recording) {
            return { ok: true, alreadyRecording: true };
        }

        if (session.activeUsers && session.activeUsers.size > 0) {
            await this.stop(session);
        }

        const receiver = session?.connection?.receiver;
        if (!receiver?.speaking) {
            throw new Error("Voice receiver is not ready. Make sure the bot is connected to a voice channel and the connection has finished setting up.");
        }

        const { meetingPath } = createMeetingFolder();
        const meetingTimestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_");
        const meetingFileName = `meeting_${meetingTimestamp}.mp3`;
        const meetingFilePath = path.join(meetingPath, meetingFileName);

        const { ffmpeg, exitPromise } = createFfmpegRecorder(meetingFilePath);
        const mixer = new SlidingWindowMixer(ffmpeg.stdin, Date.now());

        session.recording = true;
        session.isStopping = false;
        session.recordingStartTime = Date.now();
        session.recordingSessionId = `${Date.now()}`;
        session.meetingPath = meetingPath;
        session.meetingFilePath = meetingFilePath;
        session.activeUsers = new Map();
        session.speakingListener = null;
        session.mixer = mixer;
        session.ffmpegProcess = ffmpeg;
        session.ffmpegExitPromise = exitPromise;

        logEvent(session, "Recorder started", { meetingPath, meetingFilePath });

        const handleSpeakingStart = (userId) => {
            audioLog(session, "speaking start", {
                userId,
                elapsedMs: Date.now() - session.recordingStartTime,
                alreadyExists: session.activeUsers.has(userId),
                activeUsers: session.activeUsers.size,
            });

            if (!session.recording) return;

            if (session.activeUsers.has(userId)) {
                audioLog(session, "speaking start ignored duplicate", { userId });
                return;
            }

            audioLog(session, "speaking start creating user", { userId });

            createUserRecorder(session, receiver, mixer, userId);
        };

        session.speakingListener = handleSpeakingStart;
        receiver.speaking.on("start", handleSpeakingStart);

        return { ok: true, meetingPath, meetingFilePath };
    },

    async stop(session) {
        if (!session.recording) {
            return session.meetingPath || null;
        }

        session.recording = false;
        session.isStopping = true;

        const meetingPath = session.meetingPath;
        const meetingFilePath = session.meetingFilePath;

        logEvent(session, "Recorder stopping", { meetingPath, meetingFilePath });

        if (session.connection?.receiver?.speaking && session.speakingListener) {
            session.connection.receiver.speaking.off("start", session.speakingListener);
            session.speakingListener = null;
        }

        const userStates = Array.from(session.activeUsers.values());

        for (const userState of userStates) {
            try {
                userState.cleanup();
            } catch (error) {
                logError(session, "Failed to cleanup user recorder", error, { userId: userState.userId });
            }
        }

        await Promise.all(userStates.map((userState) => userState.finished.catch(() => { })));
        session.activeUsers.clear();

        if (session.mixer) {
            session.mixer.close();
        }

        if (session.ffmpegExitPromise) {
            await session.ffmpegExitPromise;
        }

        if (!meetingPath || !meetingFilePath) {
            throw new Error("Recording session was not initialized correctly.");
        }

        await waitForFileReady(meetingFilePath);

        const stats = fs.statSync(meetingFilePath);
        if (stats.size === 0) {
            throw new Error("FFmpeg produced an empty recording file.");
        }

        const duration = await getAudioDuration(meetingFilePath);
        logEvent(session, "Recording finished", { meetingFilePath, sizeBytes: stats.size, durationSeconds: duration });

        session.recording = false;
        session.isStopping = false;
        session.recordingSessionId = null;
        session.recordingStartTime = null;
        session.meetingPath = null;
        session.meetingFilePath = null;
        session.mixer = null;
        session.ffmpegProcess = null;
        session.ffmpegExitPromise = null;

        logEvent(session, "Recorder stopped", { meetingPath });
        return meetingPath;
    },
};
