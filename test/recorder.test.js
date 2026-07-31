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
                    if (this._chunk.length >= 960 * 2) {
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
            const pcm = Buffer.alloc(960 * 4, 0);
            pcm.writeInt16LE(1000, 0);
            pcm.writeInt16LE(-1000, 2);
            pcm.writeInt16LE(1000, 4);
            pcm.writeInt16LE(-1000, 6);

            setTimeout(() => {
                audio.write(pcm);
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
    const firstResult = await recorder.start(session);
    assert.ok(firstResult.meetingFilePath);
    session.connection.receiver.speaking.emit("start", "user-1");

    const firstMeetingFilePath = await recorder.stop(session);
    assert.ok(firstMeetingFilePath);
    assert.ok(fs.existsSync(firstMeetingFilePath));
    assert.ok(fs.statSync(firstMeetingFilePath).size > 0);
    await verifyMp3(firstMeetingFilePath);

    const secondResult = await recorder.start(session);
    assert.ok(secondResult.meetingFilePath);
    session.connection.receiver.speaking.emit("start", "user-2");

    const secondMeetingFilePath = await recorder.stop(session);
    assert.ok(secondMeetingFilePath);
    assert.ok(fs.existsSync(secondMeetingFilePath));
    assert.ok(fs.statSync(secondMeetingFilePath).size > 0);
    await verifyMp3(secondMeetingFilePath);

    console.log("recorder regression test passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
