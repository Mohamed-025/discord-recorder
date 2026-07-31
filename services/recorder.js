const { spawn } = require("child_process");
const { EndBehaviorType } = require("@discordjs/voice");
const fs = require("fs");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");
const prism = require("prism-media");
const SlidingWindowMixer = require("./mixer");

function createMeetingDir() {
    const meetingFolder = `meeting_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const meetingPath = path.join(__dirname, "..", "recordings", meetingFolder);
    fs.mkdirSync(meetingPath, { recursive: true });
    return { meetingFolder, meetingPath };
}

function logEvent(session, message, details = {}) {
    const sessionId = session?.recordingSessionId || session?.currentRecordingSessionId || "n/a";
    console.log(`[recorder:${sessionId}] ${message}`, details);
}

function logError(session, message, error, details = {}) {
    const sessionId = session?.recordingSessionId || session?.currentRecordingSessionId || "n/a";
    console.error(`[recorder:${sessionId}] ${message}`, {
        error: error?.message || String(error),
        ...details,
    });
}

module.exports = {
    async start(session) {
        if (session.recording) {
            return { ok: true, alreadyRecording: true };
        }

        if (session.activeStreams && session.activeStreams.size > 0) {
            await this.stop(session);
        }

        const receiver = session?.connection?.receiver;
        if (!receiver?.speaking) {
            throw new Error("Voice receiver is not ready. Make sure the bot is connected to a voice channel and the connection has finished setting up.");
        }

        const { meetingPath } = createMeetingDir();
        const meetingTimestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_");

        session.recording = true;
        session.isStopping = false;
        session.sessionStartTime = Date.now();
        session.recordingSessionId = `${Date.now()}`;
        session.currentRecordingSessionId = session.recordingSessionId;
        session.meetingPath = meetingPath;
        session.activeStreams = new Map();
        session.speakingListener = null;

        logEvent(session, "Recorder started", { meetingPath });

        // FFmpeg: read raw PCM from stdin, encode into segmented MP3 files (30 min each)
        const ffmpegArgs = [
            "-y",
            "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0",
            "-f", "segment", "-segment_time", "1800",
            "-c:a", "libmp3lame", "-b:a", "48k",
            path.join(meetingPath, `meeting_${meetingTimestamp}_%03d.mp3`)
        ];

        const ffmpeg = spawn(ffmpegPath, ffmpegArgs, { stdio: ["pipe", "ignore", "pipe"] });

        let ffmpegStderr = "";
        ffmpeg.stderr.on("data", (data) => {
            ffmpegStderr += data.toString();
        });

        ffmpeg.on("error", (error) => {
            logError(session, "FFmpeg process error", error);
        });

        ffmpeg.on("close", (code) => {
            if (code !== 0 && !session.isStopping) {
                logError(session, "FFmpeg exited unexpectedly", new Error(ffmpegStderr.slice(-500)), { code });
            }
        });

        const mixer = new SlidingWindowMixer(ffmpeg.stdin, session.sessionStartTime);
        session.ffmpeg = ffmpeg;
        session.mixer = mixer;

        // ─── Speaking Handler ───────────────────────────────────────────
        const handleSpeakingStart = (userId) => {
            if (!session.recording || session.recordingSessionId !== session.currentRecordingSessionId) {
                return;
            }

            // Already tracking this user — don't double-subscribe
            if (session.activeStreams.has(userId)) {
                return;
            }

            const audioStream = receiver.subscribe(userId, {
                end: {
                    behavior: EndBehaviorType.AfterSilence,
                    duration: 2000, // Wait 2 seconds of silence before ending (was 1s — too aggressive)
                },
            });

            const decoder = new prism.opus.Decoder({
                rate: 48000,
                channels: 2,
                frameSize: 960,
            });

            let resolveCompletion;
            const completion = new Promise((resolve) => {
                resolveCompletion = resolve;
            });

            // ── Per-user record object ──
            const record = {
                userId,
                audioStream,
                decoder,
                completion,
                closed: false,
                cleanup() {
                    if (this.closed) return;
                    this.closed = true;
                    session.activeStreams.delete(userId);

                    // Detach all listeners to prevent memory leaks
                    try {
                        audioStream.removeAllListeners();
                    } catch (_) { }

                    try {
                        decoder.removeAllListeners();
                    } catch (_) { }

                    try {
                        if (!decoder.destroyed) decoder.end();
                    } catch (_) { }

                    resolveCompletion();
                },
            };

            // ── Error handler ──
            const onStreamError = (error) => {
                if (
                    error?.code === "ERR_STREAM_DESTROYED" ||
                    error?.code === "ERR_STREAM_PREMATURE_CLOSE" ||
                    error?.code === "ABORT_ERR"
                ) {
                    record.cleanup();
                    return;
                }
                record.cleanup();
                if (!session.isStopping) {
                    logError(session, "Stream error", error, { userId });
                }
            };

            // Bail early if stream is already dead
            if (!audioStream.readable || audioStream.destroyed) {
                record.cleanup();
                return;
            }

            // ── Decoder data: mix into the shared buffer ──
            const onDecoderData = (chunk) => {
                if (!session.recording || session.recordingSessionId !== session.currentRecordingSessionId) {
                    return;
                }
                try {
                    session.mixer.writeChunk(Date.now() - session.sessionStartTime, chunk);
                } catch (error) {
                    onStreamError(error);
                }
            };

            // ── When user stops speaking ──
            const onAudioEnd = () => {
                record.cleanup();
            };

            // Wire up the pipeline: audioStream → decoder → mixer
            audioStream.on("data", (opusPacket) => {
                if (!decoder.destroyed) {
                    decoder.write(opusPacket);
                }
            });

            audioStream.on("end", () => {
                // Flush any buffered decoder data, then clean up
                if (!decoder.destroyed) {
                    decoder.end();
                }
                onAudioEnd();
            });

            audioStream.on("error", onStreamError);

            decoder.on("data", onDecoderData);
            decoder.on("error", onStreamError);
            decoder.on("end", onAudioEnd);

            session.activeStreams.set(userId, record);
            logEvent(session, "User subscribed", { userId });
        };

        session.speakingListener = handleSpeakingStart;
        receiver.speaking.on("start", handleSpeakingStart);

        return { ok: true, meetingPath };
    },

    async stop(session) {
        if (!session.recording) {
            return session.meetingPath || null;
        }

        session.recording = false;
        session.isStopping = true;
        session.currentRecordingSessionId = null;

        const meetingPath = session.meetingPath;

        logEvent(session, "Recorder stopping", { meetingPath });

        // Detach the speaking listener first to stop new subscriptions
        if (session.connection?.receiver?.speaking && session.speakingListener) {
            session.connection.receiver.speaking.off("start", session.speakingListener);
        }

        // Clean up all active streams
        const records = Array.from(session.activeStreams.values());
        session.activeStreams.clear();

        for (const record of records) {
            try {
                record.cleanup();
            } catch (error) {
                logError(session, "Failed to stop recording stream", error, { userId: record.userId });
            }
        }

        await Promise.all(records.map((r) => r.completion));

        // Close mixer (flushes remaining audio, then ends FFmpeg stdin)
        if (session.mixer) {
            try {
                session.mixer.close();
            } catch (e) {
                logError(session, "Mixer close error", e);
            }
            session.mixer = null;
        }

        // Wait for FFmpeg to finish encoding
        if (session.ffmpeg) {
            await new Promise((resolve) => {
                session.ffmpeg.once("close", resolve);
                // Safety timeout: if FFmpeg hangs, kill it after 10 seconds
                setTimeout(() => {
                    try { session.ffmpeg.kill("SIGKILL"); } catch (_) { }
                    resolve();
                }, 10000);
            });
            session.ffmpeg = null;
        }

        session.meetingPath = null;
        session.speakingListener = null;
        session.activeStreams = new Map();

        logEvent(session, "Cleanup finished", { meetingPath });
        console.log("✅ Recorder stopped.");
        return meetingPath;
    },
};