import type { JobChunk } from "./types.js";

/**
 * A bounded async queue with drop-oldest backpressure.
 *
 * The producer is a subprocess or a Docker stream; neither slows down for a slow reader,
 * so an unbounded queue turns one phone on poor LTE into unbounded server memory. Dropping
 * the oldest rather than the newest is deliberate: when output is truncated, the end is the
 * part that says what went wrong.
 *
 * Iterating is optional. Nothing here requires a consumer, and `push` after `close` is a
 * no-op rather than an error, because the process can emit a final chunk as it exits.
 */
export class ChunkQueue implements AsyncIterable<JobChunk> {
  private readonly buffer: JobChunk[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private droppedCount = 0;

  constructor(private readonly limit = 2000) {}

  push(chunk: JobChunk): void {
    if (this.closed) return;
    this.buffer.push(chunk);
    while (this.buffer.length > this.limit) {
      this.buffer.shift();
      this.droppedCount++;
    }
    this.signal();
  }

  close(): void {
    this.closed = true;
    this.signal();
  }

  get dropped(): number {
    return this.droppedCount;
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<JobChunk> {
    while (true) {
      while (this.buffer.length > 0) {
        const next = this.buffer.shift();
        if (next) yield next;
      }
      // Buffer drained. Ending only here, and not on `closed` alone, is what guarantees a
      // consumer sees chunks pushed before it started iterating.
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}
