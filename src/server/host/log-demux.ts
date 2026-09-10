import { StringDecoder } from "node:string_decoder";

export type DemuxedChunk = { text: string; stream: "stdout" | "stderr" };

const HEADER_BYTES = 8;

/**
 * Largest payload a single frame may declare.
 *
 * Docker's own log lines are capped far below this, so a larger figure means the bytes
 * are not framed at all — the likeliest cause being a stream we decided was non-TTY that
 * is actually raw, in which case arbitrary log text is being read as a length field. A
 * four-byte length can claim 4 GB; without this the parser waits forever for a payload
 * that never comes while `pending` grows for the life of the process.
 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Thrown when the byte stream cannot be framed. The caller should end the stream. */
export class LogFramingError extends Error {
  constructor(readonly declaredLength: number) {
    super(`Log frame declares ${declaredLength} bytes; the stream is not multiplexed`);
    this.name = "LogFramingError";
  }
}

/**
 * Reassembles Docker's multiplexed log framing.
 *
 * A container without a TTY gets stdout and stderr interleaved on one connection, each
 * chunk prefixed by 8 bytes: stream type, three padding bytes, then a big-endian length.
 * Reading that as text puts NULs and length bytes into the log the user is looking at.
 *
 * Stateful because a network chunk boundary lands wherever it lands — mid-header as
 * readily as mid-payload. Two decoders because a UTF-8 character can straddle two frames
 * of the same stream, and decoding each frame alone turns it into replacement characters.
 * The decoders must not be shared: a half-finished character on stdout must not be
 * completed by the first byte of a stderr frame.
 */
export class LogDemultiplexer {
  private pending: Buffer = Buffer.alloc(0);
  private readonly decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };

  push(buffer: Buffer): DemuxedChunk[] {
    this.pending = this.pending.length === 0 ? buffer : Buffer.concat([this.pending, buffer]);
    const out: DemuxedChunk[] = [];

    while (this.pending.length >= HEADER_BYTES) {
      const length = this.pending.readUInt32BE(4);
      // Fail loudly rather than buffering forever. Misframing does not resynchronise on
      // its own — every subsequent header is read at the wrong offset — so continuing
      // would emit garbage indefinitely while memory climbed.
      if (length > MAX_FRAME_BYTES) {
        this.pending = Buffer.alloc(0);
        throw new LogFramingError(length);
      }
      if (this.pending.length < HEADER_BYTES + length) break; // payload still arriving

      // Anything other than 2 is stdout. Docker uses 0 for stdin on some endpoints, and
      // filing that under the wrong stream is better than discarding the text.
      const stream = this.pending.readUInt8(0) === 2 ? "stderr" : "stdout";
      const payload = this.pending.subarray(HEADER_BYTES, HEADER_BYTES + length);
      this.pending = this.pending.subarray(HEADER_BYTES + length);

      const text = this.decoders[stream].write(payload);
      if (text !== "") out.push({ text, stream });
    }

    return out;
  }

  /**
   * Ends both decoders. A partial frame still in `pending` is discarded: its payload
   * never arrived, so there is nothing to decode. Safe to call twice.
   */
  flush(): DemuxedChunk[] {
    const out: DemuxedChunk[] = [];
    for (const stream of ["stdout", "stderr"] as const) {
      const text = this.decoders[stream].end();
      if (text !== "") out.push({ text, stream });
    }
    this.pending = Buffer.alloc(0);
    return out;
  }
}
