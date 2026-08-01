const assert = require("assert");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
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
const SAMPLE_RATE = 48000;
const FRAME_SIZE = 960;

function createFakeReceiver() {
    const speaking = new EventEmitter();
    return {
        speaking,
        subscribe(_userId) {
            const audio = new PassThrough();
            return audio;
        },
    };
}

function generateTone(amplitude, samples) {
    const buffer = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        buffer.writeInt16LE(amplitude, i * 2);
    }
    return buffer;
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
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

async function runScenario(scenario) {
    const session = createFakeSession();
    const result = await recorder.start(session);
    assert.ok(result.meetingFilePath, "Recorder should return meetingFilePath");

    const startCountBefore = session.connection.receiver.speaking.listenerCount("start");
    assert.strictEqual(startCountBefore, 1, "Recorder should add exactly one speaking listener");

    for (const speakerEvent of scenario.events) {
        await sleep(speakerEvent.delayMs);
        session.connection.receiver.speaking.emit("start", speakerEvent.userId);
        const audio = session.connection.receiver.subscribe(speakerEvent.userId);
        audio.write(generateTone(speakerEvent.amplitude, FRAME_SIZE));
        audio.end();
        if (speakerEvent.duplicateStart) {
            session.connection.receiver.speaking.emit("start", speakerEvent.userId);
        }
        await sleep(5);
        assert.ok(session.activeUsers.size <= 3, "A speaker should create only one active user entry at a time");
    }

    const meetingFolder = await recorder.stop(session);
    assert.ok(meetingFolder);
    assert.ok(fs.existsSync(meetingFolder));
    const mp3Files = fs.readdirSync(meetingFolder).filter((name) => name.toLowerCase().endsWith(".mp3"));
    assert.ok(mp3Files.length > 0, "Expected MP3 output file");
    const meetingFilePath = path.join(meetingFolder, mp3Files[0]);
    assert.ok(fs.statSync(meetingFilePath).size > 0, "Output MP3 file must be non-empty");
    await verifyMp3(meetingFilePath);

    const startCountAfter = session.connection.receiver.speaking.listenerCount("start");
    assert.strictEqual(startCountAfter, 0, "Recorder should remove speaking listener after stop");

    return meetingFilePath;
}

function createFakeSession() {
    return {
        connection: { receiver: createFakeReceiver() },
    };
}

(async () => {
    const scenarios = [
        {
            name: "A only",
            events: [
                { delayMs: 0, userId: "A", amplitude: 3000, duplicateStart: true },
            ],
        },
        {
            name: "A+B",
            events: [
                { delayMs: 0, userId: "A", amplitude: 2000, duplicateStart: false },
                { delayMs: 10, userId: "B", amplitude: 1500, duplicateStart: false },
            ],
        },
        {
            name: "A+B+C",
            events: [
                { delayMs: 0, userId: "A", amplitude: 2000, duplicateStart: false },
                { delayMs: 10, userId: "B", amplitude: 1500, duplicateStart: false },
                { delayMs: 10, userId: "C", amplitude: 1000, duplicateStart: false },
            ],
        },
        {
            name: "Rapid switches",
            events: [
                { delayMs: 0, userId: "A", amplitude: 1800, duplicateStart: false },
                { delayMs: 5, userId: "B", amplitude: 1700, duplicateStart: false },
                { delayMs: 5, userId: "A", amplitude: 1800, duplicateStart: false },
                { delayMs: 5, userId: "C", amplitude: 1600, duplicateStart: false },
                { delayMs: 5, userId: "B", amplitude: 1700, duplicateStart: false },
            ],
        },
    ];

    for (const scenario of scenarios) {
        console.log(`Running scenario: ${scenario.name}`);
        await runScenario(scenario);
    }

    console.log("multi-speaker integration tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
