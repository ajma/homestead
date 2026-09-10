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
  /** Stream index of `buffer[0]`. Rises as chunks are dropped, so cursors stay meaningful. */
  private base = 0;
  private readonly waiters = new Set<() => void>();
  private closed = false;
  private droppedCount = 0;

  constructor(private readonly limit = 2000) {}

  push(chunk: JobChunk): void {
    if (this.closed) return;
    this.buffer.push(chunk);
    while (this.buffer.length > this.limit) {
      this.buffer.shift();
      this.base++;
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
    // Copy and clear: a waiter re-registers on its next loop, and resolving while
    // iterating the live set would skip entries.
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiting) wake();
  }

  /**
   * Each iterator gets its OWN cursor, so two consumers both see every chunk.
   *
   * Consuming by shifting off a shared buffer looks simpler and is wrong here: two browser
   * tabs watching one deploy would split the output between them, and with a single
   * stored waiter the second would hang after the first chunk. A job's stream is watched
   * by however many tabs the user has open.
   *
   * A cursor that falls behind the retained window jumps to `base` — it has been dropped
   * past, which is the backpressure working, not an error.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<JobChunk> {
    let cursor = this.base;
    while (true) {
      if (cursor < this.base) cursor = this.base;
      while (cursor < this.base + this.buffer.length) {
        const next = this.buffer[cursor - this.base];
        cursor++;
        if (next) yield next;
      }
      // Drained. Ending only here, not on `closed` alone, is what guarantees a consumer
      // sees chunks pushed before it started iterating.
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
      });
    }
  }
}
