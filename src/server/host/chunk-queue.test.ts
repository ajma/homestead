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

  it("ignores pushes after close rather than throwing", async () => {
    const queue = new ChunkQueue();
    queue.close();
    queue.push({ text: "ignored", stream: "stdout" });
    expect(await drain(queue)).toEqual([]);
  });
});
