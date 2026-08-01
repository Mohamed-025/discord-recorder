/**
 * SlidingWindowMixer — Real-time PCM Audio Mixer
 *
 * Accepts decoded PCM chunks from multiple Discord voice streams,
 * mixes them additively in a circular time-based buffer, and
 * flushes the oldest data to FFmpeg's stdin at regular intervals.
 *
 * Design:
 *   - 10-second buffer window to absorb network jitter
 *   - Flush every 500ms; only flushes data older than 3 seconds
 *   - Int16 additive mixing with hard clamp at ±32767
 *   - Late data (within 500ms grace) is still mixed; only truly stale data is dropped
 */

class SlidingWindowMixer {
    constructor(outputStream, startTime) {
        this.outputStream = outputStream;
        this.startTime = startTime;
        this.closed = false;

        this.sampleRate = 48000;
        this.channels = 2;
        this.bytesPerSample = 2;
        // 48000 Hz * 2 channels * 2 bytes = 192,000 bytes per second = 192 bytes per ms
        this.bytesPerMs = (this.sampleRate * this.channels * this.bytesPerSample) / 1000;

        this.windowMs = 10000; // 10-second buffer
        this.bufferSize = Math.floor(this.windowMs * this.bytesPerMs);
        this.buffer = Buffer.alloc(this.bufferSize, 0);
        this.flushCount = 0;
        this.latestWriteTimeMs = 0;

        // headTimeMs = the earliest timestamp currently represented in the buffer
        this.headTimeMs = 0;

        // Amount of jitter tolerance: data arriving up to this many ms late
        // relative to headTimeMs is silently dropped rather than erroring
        this.lateToleranceMs = 500;

        // Flush interval & delay
        this.flushDelayMs = 1000; // Only flush data older than 3 seconds
        this.interval = setInterval(() => this._autoFlush(), 40);
    }

    /**
     * Mix a PCM chunk into the buffer at the given elapsed-time position.
     * @param {number} timeMs - elapsed milliseconds since recording started
     * @param {Buffer} chunk  - raw s16le PCM data (48kHz stereo)
     */
    writeChunk(timeMs, chunk) {
        if (this.closed || !chunk || chunk.length < 2) return;

        let offsetMs = timeMs - this.headTimeMs;

        // Allow slight late data within tolerance; truly stale data is dropped
        if (offsetMs < -this.lateToleranceMs) return;
        if (offsetMs < 0) offsetMs = 0; // Clamp slightly-late data to buffer head

        // If the chunk would land past the end of the buffer, flush to make room
        while (Math.floor(offsetMs * this.bytesPerMs) + chunk.length > this.bufferSize) {
            this._forceFlush(1000);
            offsetMs = timeMs - this.headTimeMs;
            if (offsetMs < 0) offsetMs = 0;
        }

        const byteOffset = Math.floor(offsetMs * this.bytesPerMs);
        // Ensure byte offset is even (Int16 alignment)
        const alignedOffset = byteOffset - (byteOffset % 2);

        const frameCount = chunk.length / (this.channels * this.bytesPerSample);
        const chunkEndTimeMs = timeMs + (frameCount / this.sampleRate) * 1000;
        this.latestWriteTimeMs = Math.max(this.latestWriteTimeMs, chunkEndTimeMs);

        // Additive mix with hard clamp
        for (let i = 0; i < chunk.length - 1; i += 2) {
            const bufPos = alignedOffset + i;
            if (bufPos + 1 >= this.bufferSize) break;

            const existing = this.buffer.readInt16LE(bufPos);
            const incoming = chunk.readInt16LE(i);

            let mixed = existing + incoming;
            if (mixed > 32767) mixed = 32767;
            else if (mixed < -32768) mixed = -32768;

            this.buffer.writeInt16LE(mixed, bufPos);
        }
    }

    /**
     * Auto-flush: called by the interval timer.
     * Flushes data that's older than flushDelayMs from the current time.
     */
    _autoFlush() {
        if (this.closed) return;

        const currentElapsed = Date.now() - this.startTime;
        const safeFlushUpTo = currentElapsed - this.flushDelayMs;
        const flushMs = Math.floor(safeFlushUpTo - this.headTimeMs);

        if (flushMs <= 0) return;
        this._flushMs(flushMs);
    }

    /**
     * Force-flush a specific number of milliseconds from the buffer head.
     * Used by writeChunk when the buffer is full.
     */
    _forceFlush(ms) {
        this._flushMs(ms);
    }

    /**
     * Core flush implementation: write `ms` worth of audio from the buffer head
     * to the output stream, shift buffer left, zero the freed tail.
     */
    _flushMs(ms) {
        if (ms <= 0) return;

        const bytesToFlush = Math.floor(ms * this.bytesPerMs);
        // Ensure even alignment
        const aligned = bytesToFlush - (bytesToFlush % 2);

        if (aligned <= 0) return;
        if (aligned > this.bufferSize) {
            // Edge case: if event-loop was blocked so long that we need to flush
            // more than the entire buffer, just flush the whole thing
            this._writeToOutput(this.buffer.subarray(0, this.bufferSize));
            this.buffer.fill(0);
            this.headTimeMs += Math.floor(this.bufferSize / this.bytesPerMs);
            return;
        }

        // Copy the data to flush into a fresh buffer
        const chunk = Buffer.allocUnsafe(aligned);
        this.buffer.copy(chunk, 0, 0, aligned);

        this._writeToOutput(chunk);
        this.flushCount += 1;

        // Shift remaining data left
        this.buffer.copy(this.buffer, 0, aligned);
        // Zero the freed tail space
        this.buffer.fill(0, this.bufferSize - aligned);

        this.headTimeMs += Math.floor(aligned / this.bytesPerMs);
    }

    /**
     * Write a buffer to the output stream (FFmpeg stdin).
     */
    _writeToOutput(buf) {
        try {
            if (this.outputStream && !this.outputStream.destroyed && this.outputStream.writable) {
                this.outputStream.write(buf);
            }
        } catch (err) {
            console.error("[SlidingWindowMixer] Write error:", err.message);
        }
    }

    getBufferedTimeMs() {
        return Math.max(0, this.latestWriteTimeMs - this.headTimeMs);
    }

    getFlushCount() {
        return this.flushCount;
    }

    /**
     * Close the mixer: flush all remaining buffered audio, then end the output stream.
     */
    close() {
        if (this.closed) return;
        this.closed = true;

        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }

        const bufferedMs = Math.max(0, this.latestWriteTimeMs - this.headTimeMs);
        const bytesToFlush = Math.min(
            Math.floor(bufferedMs * this.bytesPerMs),
            this.bufferSize
        );

        if (bytesToFlush > 0) {
            const aligned = bytesToFlush - (bytesToFlush % 2);
            if (aligned > 0) {
                const finalChunk = Buffer.allocUnsafe(aligned);
                this.buffer.copy(finalChunk, 0, 0, aligned);
                this._writeToOutput(finalChunk);
                this.flushCount += 1;
            }
        }

        // End the FFmpeg stdin pipe
        try {
            if (this.outputStream && !this.outputStream.destroyed) {
                this.outputStream.end();
            }
        } catch (e) {
            // Ignore close errors
        }
    }
}

module.exports = SlidingWindowMixer;
