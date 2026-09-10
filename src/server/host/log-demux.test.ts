import { LogDemultiplexer, LogFramingError } from "@server/host/log-demux";
import { describe, expect, it } from "vitest";

/** Builds one Docker log frame: 1 byte stream, 3 padding, 4-byte big-endian length. */
function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const textOf = (chunks: Array<{ text: string }>) => chunks.map((c) => c.text).join("");

describe("LogDemultiplexer", () => {
  it("separates stdout from stderr", () => {
    const demux = new LogDemultiplexer();
    const out = demux.push(Buffer.concat([frame(1, "to stdout\n"), frame(2, "to stderr\n")]));
    expect(out).toEqual([
      { text: "to stdout\n", stream: "stdout" },
      { text: "to stderr\n", stream: "stderr" },
    ]);
  });

  it("never emits the 8-byte header as text", () => {
    const demux = new LogDemultiplexer();
    const out = demux.push(frame(1, "clean line\n"));
    // The bug this class exists to prevent: the header's NUL and length bytes appearing
    // in the log the user reads.
    expect(textOf(out)).toBe("clean line\n");
    expect(textOf(out)).not.toContain("\0");
  });

  it("reassembles frames split at EVERY byte boundary", () => {
    // The case that breaks a naive parser. A network chunk boundary lands wherever it
    // lands — inside the header, inside the payload, between the two.
    const whole = Buffer.concat([frame(1, "alpha"), frame(2, "beta"), frame(1, "gamma")]);
    for (let cut = 1; cut < whole.length; cut++) {
      const demux = new LogDemultiplexer();
      const chunks = [...demux.push(whole.subarray(0, cut)), ...demux.push(whole.subarray(cut))];
      expect(textOf(chunks), `split at ${cut}`).toBe("alphabetagamma");
      expect(
        chunks
          .filter((c) => c.stream === "stderr")
          .map((c) => c.text)
          .join(""),
      ).toBe("beta");
    }
  });

  it("reassembles one byte at a time", () => {
    const whole = frame(1, "drip");
    const demux = new LogDemultiplexer();
    const chunks = [];
    for (const byte of whole) chunks.push(...demux.push(Buffer.from([byte])));
    expect(textOf(chunks)).toBe("drip");
  });

  it("keeps a multi-byte character intact when it straddles two frames", () => {
    // 'é' is two bytes in UTF-8, here delivered as two complete one-byte frames.
    // Decoding each frame on its own yields U+FFFD twice, which is what a per-frame
    // `toString('utf8')` produces and why each stream needs a persistent decoder.
    const accented = Buffer.from("é", "utf8");
    const oneBytePayload = (byte: Buffer) =>
      Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 1]), byte]);

    const demux = new LogDemultiplexer();
    const out = [
      ...demux.push(oneBytePayload(accented.subarray(0, 1))),
      ...demux.push(oneBytePayload(accented.subarray(1, 2))),
    ];
    expect(textOf(out)).toBe("é");
    expect(textOf(out)).not.toContain("�");
  });

  it("does not interleave the two streams decoders", () => {
    // A partial UTF-8 sequence on stdout must not be completed by bytes from stderr.
    const demux = new LogDemultiplexer();
    const euro = Buffer.from("é", "utf8");
    const out = [
      ...demux.push(Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 1]), euro.subarray(0, 1)])),
      ...demux.push(frame(2, "X")),
      ...demux.push(Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 1]), euro.subarray(1, 2)])),
    ];
    expect(
      out
        .filter((c) => c.stream === "stderr")
        .map((c) => c.text)
        .join(""),
    ).toBe("X");
    expect(
      out
        .filter((c) => c.stream === "stdout")
        .map((c) => c.text)
        .join(""),
    ).toBe("é");
  });

  it("emits nothing for a zero-length frame", () => {
    expect(new LogDemultiplexer().push(frame(1, ""))).toEqual([]);
  });

  it("throws rather than buffering forever on an impossible frame length", () => {
    // A four-byte length can claim 4 GB. The payload never arrives, so a parser that just
    // waits grows `pending` for the life of the process — and misframing never
    // resynchronises, because every later header is read at the wrong offset. The
    // realistic cause is a raw TTY stream being fed through the frame parser, where
    // ordinary log text is read as a length.
    const header = Buffer.alloc(8);
    header.writeUInt8(1, 0);
    header.writeUInt32BE(0xffffffff, 4);
    const demux = new LogDemultiplexer();
    expect(() => demux.push(header)).toThrow(LogFramingError);
    // And it does not keep the bytes it could not parse.
    expect(() => demux.push(Buffer.from("more"))).not.toThrow();
  });

  it("accepts a frame right at the size limit", () => {
    const header = Buffer.alloc(8);
    header.writeUInt8(1, 0);
    header.writeUInt32BE(16 * 1024 * 1024, 4);
    // Declared but not yet delivered: it waits, rather than rejecting a legal frame.
    expect(new LogDemultiplexer().push(header)).toEqual([]);
  });

  it("discards a partial frame on flush rather than emitting half a payload", () => {
    const demux = new LogDemultiplexer();
    const header = Buffer.alloc(8);
    header.writeUInt8(1, 0);
    header.writeUInt32BE(4, 4);
    demux.push(Buffer.concat([header, Buffer.from("ab")])); // 2 of 4 bytes
    expect(demux.flush()).toEqual([]);
    expect(demux.flush()).toEqual([]);
  });

  it("treats an unknown stream byte as stdout rather than dropping the payload", () => {
    // Docker uses 0 for stdin on some endpoints. Losing the text would be worse than
    // filing it under the wrong stream.
    const demux = new LogDemultiplexer();
    const header = Buffer.alloc(8);
    header.writeUInt8(0, 0);
    header.writeUInt32BE(4, 4);
    const out = demux.push(Buffer.concat([header, Buffer.from("data")]));
    expect(out).toEqual([{ text: "data", stream: "stdout" }]);
  });
});
