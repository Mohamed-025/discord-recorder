const { spawn } = require("child_process");
const { EndBehaviorType } = require("@discordjs/voice");
const fs = require("fs");
const path = require("path");
const { PassThrough, pipeline } = require("stream");

const ffmpegPath = require("ffmpeg-static");
const prism = require("prism-media");

function createMeetingDir() {
    const meetingFolder = `meeting_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const meetingPath = path.join(__dirname, "..", "recordings", meetingFolder);
    fs.mkdirSync(meetingPath, { recursive: true });
    return { meetingFolder, meetingPath };
}

function createFfmpegProcess(outputFilePath) {
    return spawn(
        ffmpegPath,
        [
            "-y",
            "-loglevel",
            "error",
            "-f",
            "s16le",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-i",
            "-",
            "-vn",
            "-acodec",
            "libmp3lame",
            "-b:a",
            "128k",
            "-f",
            "mp3",
            outputFilePath,
        ],
        { stdio: ["pipe", "inherit", "inherit"] }
    );
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
        const meetingFileName = `meeting_${meetingTimestamp}.mp3`;
        const meetingFilePath = path.join(meetingPath, meetingFileName);

        session.recording = true;
        session.isStopping = false;
        session.recordingSessionId = `${Date.now()}`;
        session.currentRecordingSessionId = session.recordingSessionId;
        session.meetingPath = meetingPath;
        session.meetingFilePath = meetingFilePath;
        session.activeStreams = new Map();
        session.meetingFfmpeg = null;
        session.meetingInput = null;
        session.speakingListener = null;

        console.log("🎙️ Recorder Ready");
        console.log("Meeting Folder:", meetingPath);

        const ffmpeg = createFfmpegProcess(meetingFilePath);
        const input = new PassThrough();
        input.pipe(ffmpeg.stdin);

        session.meetingFfmpeg = ffmpeg;
        session.meetingInput = input;

        const handleSpeakingStart = (userId) => {
            if (!session.recording || session.recordingSessionId !== session.currentRecordingSessionId) {
                return;
            }

            if (session.activeStreams.has(userId)) {
                return;
            }

            const audioStream = receiver.subscribe(userId, {
                end: {
                    behavior: EndBehaviorType.AfterSilence,
                    duration: 1000,
                },
            });

            const decoder = new prism.opus.Decoder({
                rate: 48000,
                channels: 2,
                frameSize: 960,
            });

            const cleanup = () => {
                const current = session.activeStreams.get(userId);
                if (current?.audioStream === audioStream) {
                    session.activeStreams.delete(userId);
                }
                try {
                    audioStream.removeAllListeners();
                    decoder.removeAllListeners();
                } catch (error) {
                    // ignore cleanup listener errors
                }
            };

            const onStreamError = (error) => {
                if (error?.code === "ERR_STREAM_DESTROYED") {
                    cleanup();
                    return;
                }
                cleanup();
                if (!session.isStopping && error?.code !== "ERR_STREAM_PREMATURE_CLOSE") {
                    console.error(`❌ Stream error for ${userId}:`, error);
                }
            };

            const pipelineDone = (error) => {
                if (error) {
                    if (!session.isStopping && error.code !== "ERR_STREAM_PREMATURE_CLOSE") {
                        console.error(`❌ Recording error for ${userId}:`, error);
                    }
                } else {
                    console.log(`✅ Audio segment finished for ${userId}`);
                }
                cleanup();
            };

            if (!audioStream.readable || audioStream.destroyed) {
                cleanup();
                return;
            }

            try {
                pipeline(audioStream, decoder, input, (error) => pipelineDone(error));
            } catch (error) {
                onStreamError(error);
                return;
            }

            audioStream.setMaxListeners(20);
            decoder.setMaxListeners(20);

            session.activeStreams.set(userId, { audioStream, decoder, input });

            audioStream.on("end", cleanup);
            audioStream.on("error", onStreamError);
            decoder.on("error", onStreamError);
            ffmpeg.on("error", onStreamError);

            console.log(`✅ Audio stream created for ${userId}`);
        };

        session.speakingListener = handleSpeakingStart;
        receiver.speaking.on("start", handleSpeakingStart);

        return { ok: true, meetingPath, meetingFilePath };
    },

    async stop(session) {
        if (!session.recording) {
            return session.meetingFilePath || null;
        }

        session.recording = false;
        session.isStopping = true;
        session.currentRecordingSessionId = null;

        const meetingFilePath = session.meetingFilePath;

        if (session.activeStreams) {
            for (const [userId, record] of Array.from(session.activeStreams.entries())) {
                try {
                    if (record.audioStream && !record.audioStream.destroyed) {
                        record.audioStream.destroy();
                    }
                    if (record.decoder && !record.decoder.destroyed) {
                        record.decoder.destroy();
                    }
                } catch (error) {
                    console.warn(`⚠️ Failed to destroy stream for ${userId}:`, error.message);
                }
                console.log(`🛑 Closed stream for ${userId}`);
            }
            session.activeStreams.clear();
        }

        if (session.connection?.receiver?.speaking && session.speakingListener) {
            session.connection.receiver.speaking.off("start", session.speakingListener);
        }

        if (session.meetingInput) {
            session.meetingInput.end();
        }

        if (session.meetingFfmpeg) {
            await new Promise((resolve) => {
                const done = () => {
                    console.log("✅ FFmpeg stream closed.");
                    resolve();
                };

                session.meetingFfmpeg.once("close", done);
                session.meetingFfmpeg.once("exit", done);
                session.meetingFfmpeg.once("error", done);

                setTimeout(() => {
                    if (session.meetingFfmpeg && !session.meetingFfmpeg.killed) {
                        session.meetingFfmpeg.kill("SIGTERM");
                    }
                }, 2000);
            });
        }

        session.meetingFfmpeg = null;
        session.meetingInput = null;
        session.meetingFilePath = null;
        session.meetingPath = null;
        session.speakingListener = null;

        console.log("✅ Recorder stopped.");
        return meetingFilePath;
    }
};