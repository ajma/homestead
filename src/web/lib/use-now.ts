import { useEffect, useState } from "react";

/**
 * One shared clock for the whole app. Thirty tiles calling `useNow()` must not mean
 * thirty timers: every consumer registers in this module-level set, and a single
 * interval ticks all of them. The interval starts when the first subscriber mounts and
 * is cleared the moment the last one unmounts — leaving it running with zero
 * subscribers is a leak.
 */
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  for (const notify of subscribers) notify();
}

function subscribe(notify: () => void, intervalMs: number): () => void {
  subscribers.add(notify);
  if (timer === null) {
    timer = setInterval(tick, intervalMs);
  }
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Current time in epoch seconds, re-rendering the caller on every tick of the shared clock. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    return subscribe(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
  }, [intervalMs]);

  return now;
}
