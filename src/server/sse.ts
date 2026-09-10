import type { FastifyReply, FastifyRequest } from "fastify";

/** Comment frame every 25s. Keeps intermediaries from closing an idle stream. */
const HEARTBEAT_MS = 25_000;

/**
 * Turns a reply into a Server-Sent Events stream.
 *
 * `X-Accel-Buffering: no` matters even though Homestead has no nginx in front of it
 * today: a user putting one there would otherwise see nothing until the stream closed,
 * which looks exactly like a hung job.
 */
export function sseResponse(request: FastifyRequest, reply: FastifyReply) {
  // Tells Fastify we own the socket from here. Without it Fastify also tries to send a
  // response, and its headers arrive after ours have already gone out on the wire.
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.flushHeaders();

  let open = true;
  const heartbeat = setInterval(() => {
    if (open) reply.raw.write(": ping\n\n");
  }, HEARTBEAT_MS);

  const close = () => {
    if (!open) return;
    open = false;
    clearInterval(heartbeat);
    reply.raw.end();
  };

  const closed = new Promise<void>((resolve) => {
    const finish = () => {
      open = false;
      clearInterval(heartbeat);
      resolve();
    };
    // Both ends, and `error` as well as `close`. A socket that errors without emitting
    // `close` would otherwise leave the heartbeat firing every 25s for the life of the
    // process — one leaked timer per abandoned stream, still writing to a dead socket.
    request.raw.on("close", finish);
    request.raw.on("error", finish);
    reply.raw.on("close", finish);
    reply.raw.on("error", finish);
  });

  return {
    send(event: string, data: unknown): void {
      if (!open) return;
      // One JSON object per event, so a newline inside the payload cannot terminate the
      // frame — a log line containing "\n\n" would otherwise split into two events.
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close,
    closed,
  };
}
