const assert = require("assert");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const ffmpegPath = require("ffmpeg-static");

const prismPath = require.resolve("prism-media");
const stream = require("stream");

require.cache[prismPath] = {
    id: prismPath,
    filename: prismPath,
    loaded: true,
    exports: {
        opus: {
            Decoder: class FakeDecoder extends stream.Transform {
                constructor(options) {
                    super(options);
                    this._chunk = Buffer.alloc(0);
                }

                _transform(chunk, _encoding, callback) {
                    this._chunk = Buffer.concat([this._chunk, chunk]);
                    while (this._chunk.length >= 960 * 2) {
                        this.push(this._chunk.slice(0, 960 * 2));
                        this._chunk = this._chunk.slice(960 * 2);
                    }
                    callback();
                }

                _flush(callback) {
                    if (this._chunk.length) {
                        this.push(this._chunk);
                    }
                    callback();
                }
            },
        },
    },
};

const recorder = require("../services/recorder");

function createFakeReceiver() {
    const speaking = new EventEmitter();
    return {
        speaking,
        subscribe(_userId) {
            const audio = new PassThrough();
            setTimeout(() => {
                audio.end();
            }, 10);
            return audio;
        },
    };
}

function createSession() {
    return {
        connection: { receiver: createFakeReceiver() },
    };
}

function generateToneBuffer(amplitude, sampleCount) {
    const buffer = Buffer.alloc(sampleCount * 2);
    for (let i = 0; i < sampleCount; i++) {
        buffer.writeInt16LE(amplitude, i * 2);
    }
    return buffer;
}

function createTimedSpeaker(receiver, userId, segments) {
    return async () => {
        for (const segment of segments) {
            await new Promise((resolve) => setTimeout(resolve, segment.waitMs));
            receiver.speaking.emit("start", userId);
            const audioStream = receiver.subscribe(userId);
            setTimeout(() => {
                const tone = generateToneBuffer(segment.amplitude, segment.samples);
                audioStream.write(tone);
                audioStream.end();
            }, 0);
        }
    };
}

async function verifyMp3(filePath) {
    await new Promise((resolve, reject) => {
        execFile(ffmpegPath, ["-v", "error", "-i", filePath, "-f", "null", "-"], (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

(async () => {
    const session = createSession();
    const result = await recorder.start(session);
    assert.ok(result.meetingFilePath);

    const receiver = session.connection.receiver;
    const events = [];

    receiver.speaking.on("start", (userId) => {
        events.push({ event: "start", userId, time: Date.now() });
    });

    for (let i = 0; i < 20; i++) {
        receiver.speaking.emit("start", "user-1");
        receiver.speaking.emit("start", "user-1");
        assert.strictEqual(session.activeUsers.size, 1, "Duplicate subscriptions should not create additional active users");
        await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const meetingFolder = await recorder.stop(session);
    assert.ok(meetingFolder);
    const mp3Files = fs.readdirSync(meetingFolder).filter((name) => name.toLowerCase().endsWith(".mp3"));
    assert.ok(mp3Files.length > 0, "Expected MP3 output");
    const meetingFile = path.join(meetingFolder, mp3Files[0]);
    assert.ok(fs.statSync(meetingFile).size > 0);
    await verifyMp3(meetingFile);

    console.log("recorder integration test passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
