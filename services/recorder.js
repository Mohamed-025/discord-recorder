const { spawn } = require("child_process");
const { EndBehaviorType } = require("@discordjs/voice");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream");
const prism = require("prism-media");

const ffmpegPath = require("ffmpeg-static");

function createMeetingDir() {
    const meetingFolder = `meeting_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const meetingPath = path.join(__dirname, "..", "recordings", meetingFolder);
    fs.mkdirSync(meetingPath, { recursive: true });
    return { meetingFolder, meetingPath };
}

function safeUserFileName(userId) {
    return `${userId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function mixUserAudioFiles(meetingPath, outputFilePath) {
    const userFiles = fs
        .readdirSync(meetingPath)
        .filter((file) => file.endsWith(".pcm"))
        .map((file) => path.join(meetingPath, file));

    if (!userFiles.length) {
        throw new Error("No user audio files to mix.");
    }

    const args = ["-y"];
    for (const filePath of userFiles) {
        args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "-i", filePath);
    }

    if (userFiles.length === 1) {
        args.push("-vn", "-acodec", "libmp3lame", "-b:a", "128k", outputFilePath);
    } else {
        args.push(
            "-filter_complex",
            `amix=inputs=${userFiles.length}:dropout_transition=2`,
            "-vn",
            "-acodec",
            "libmp3lame",
            "-b:a",
            "128k",
            outputFilePath
        );
    }

    const ffmpeg = spawn(ffmpegPath, args, {
        stdio: ["ignore", "inherit", "inherit"],
    });

    return new Promise((resolve, reject) => {
        ffmpeg.once("error", reject);
        ffmpeg.once("close", (code) => {
            if (code === 0) {
                resolve(outputFilePath);
            } else {
                reject(new Error(`FFmpeg exited with code ${code}`));
            }
        });
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
        const meetingFileName = `meeting_${meetingTimestamp}.mp3`;
        const meetingFilePath = path.join(meetingPath, meetingFileName);

        session.recording = true;
        session.isStopping = false;
        session.recordingSessionId = `${Date.now()}`;
        session.currentRecordingSessionId = session.recordingSessionId;
        session.meetingPath = meetingPath;
        session.meetingFilePath = meetingFilePath;
        session.activeStreams = new Map();
        session.speakingListener = null;

        console.log("🎙️ Recorder Ready");
        console.log("Meeting Folder:", meetingPath);

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

            const userFilePath = path.join(meetingPath, `${safeUserFileName(userId)}.pcm`);
            const fileStream = fs.createWriteStream(userFilePath, { flags: "a" });

            const cleanup = () => {
                const current = session.activeStreams.get(userId);
                if (current?.audioStream === audioStream) {
                    session.activeStreams.delete(userId);
                }
                try {
                    audioStream.removeAllListeners();
                    decoder.removeAllListeners();
                    fileStream.removeAllListeners();
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
                if (error && !session.isStopping && error.code !== "ERR_STREAM_PREMATURE_CLOSE") {
                    console.error(`❌ Recording error for ${userId}:`, error);
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
                pipeline(audioStream, decoder, fileStream, (error) => pipelineDone(error));
            } catch (error) {
                onStreamError(error);
                return;
            }

            audioStream.setMaxListeners(20);
            decoder.setMaxListeners(20);
            fileStream.setMaxListeners(20);

            session.activeStreams.set(userId, { audioStream, decoder, fileStream, userFilePath });

            audioStream.on("end", cleanup);
            audioStream.on("error", onStreamError);
            decoder.on("error", onStreamError);
            fileStream.on("error", onStreamError);

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

        const closePromises = [];
        if (session.activeStreams) {
            for (const [userId, record] of Array.from(session.activeStreams.entries())) {
                try {
                    if (record.audioStream && !record.audioStream.destroyed) {
                        record.audioStream.destroy();
                    }
                    if (record.fileStream && !record.fileStream.destroyed && !record.fileStream.writableEnded) {
                        closePromises.push(new Promise((resolve) => record.fileStream.end(resolve)));
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

        await Promise.all(closePromises);

        if (session.meetingPath && session.meetingFilePath) {
            await mixUserAudioFiles(session.meetingPath, session.meetingFilePath);
        }

        session.meetingFilePath = null;
        session.meetingPath = null;
        session.speakingListener = null;

        console.log("✅ Recorder stopped.");
        return meetingFilePath;
    },
};