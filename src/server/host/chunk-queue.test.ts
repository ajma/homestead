import { ChunkQueue } from "@server/host/chunk-queue";
import { describe, expect, it } from "vitest";

const drain = async (queue: ChunkQueue) => {
  const seen: string[] = [];
  for await (const chunk of queue) seen.push(chunk.text);
  return seen;
};

describe("ChunkQueue", () => {
  it("yields everything pushed before iteration started", async () => {
    const queue = new ChunkQueue();
    queue.push({ text: "a", stream: "stdout" });
    queue.push({ text: "b", stream: "stdout" });
    queue.close();
    expect(await drain(queue)).toEqual(["a", "b"]);
  });

  it("wakes an iterator that is waiting when a chunk arrives", async () => {
    const queue = new ChunkQueue();
    const collected = drain(queue);
    await new Promise((r) => setTimeout(r, 5)); // let the iterator reach its await
    queue.push({ text: "late", stream: "stderr" });
    queue.close();
    expect(await collected).toEqual(["late"]);
  });

  it("terminates an iterator that is waiting when the queue closes", async () => {
    const queue = new ChunkQueue();
    const collected = drain(queue);
    await new Promise((r) => setTimeout(r, 5));
    queue.close();
    expect(await collected).toEqual([]);
  });

  it("drops the OLDEST chunks past the limit, keeping the newest", async () => {
    // Drop-oldest, not drop-newest: a phone on poor LTE must not balloon server memory,
    // and when output is truncated the end is the part that says what went wrong.
    const queue = new ChunkQueue(3);
    for (const text of ["1", "2", "3", "4", "5"]) queue.push({ text, stream: "stdout" });
    queue.close();
    expect(await drain(queue)).toEqual(["3", "4", "5"]);
    expect(queue.dropped).toBe(2);
  });

  it("gives every concurrent consumer the whole stream", async () => {
    // Two browser tabs watching one deploy. A queue that shifts off a shared buffer
    // splits the output between them, and with one stored waiter the second hangs after
    // the first chunk — measured against the first implementation.
    const queue = new ChunkQueue();
    const first = drain(queue);
    const second = drain(queue);
    await new Promise((r) => setTimeout(r, 5));
    queue.push({ text: "a", stream: "stdout" });
    queue.push({ text: "b", stream: "stdout" });
    queue.close();
    expect(await first).toEqual(["a", "b"]);
    expect(await second).toEqual(["a", "b"]);
  });

  it("lets a consumer that fell behind resume at the oldest retained chunk", async () => {
    const queue = new ChunkQueue(2);
    queue.push({ text: "1", stream: "stdout" });
    queue.push({ text: "2", stream: "stdout" });
    queue.push({ text: "3", stream: "stdout" });
    queue.close();
    // '1' is gone; the consumer picks up from what is still retained rather than stalling.
    expect(await drain(queue)).toEqual(["2", "3"]);
  });

  it("survives a consumer that breaks out early", async () => {
    const queue = new ChunkQueue();
    queue.push({ text: "a", stream: "stdout" });
    for await (const _ of queue) break;
    queue.push({ text: "b", stream: "stdout" });
    queue.close();
    // The abandoned waiter must not wedge later pushes or a later consumer.
    expect(await drain(queue)).toEqual(["a", "b"]);
  });

  it("ignores pushes after close rather than throwing", async () => {
    const queue = new ChunkQueue();
    queue.close();
    queue.push({ text: "ignored", stream: "stdout" });
    expect(await drain(queue)).toEqual([]);
  });
});
