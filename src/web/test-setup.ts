import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";

/**
 * No unit test may reach the network. jsdom resolves a relative path against
 * its own origin, so an unstubbed `apiFetch("/api/…")` becomes a real request
 * rather than an obvious error — a component that quietly fetches on mount
 * passes its tests and hits the network anyway. That happened: AppShell's
 * preflight query did it in every one of its tests and survived three reviews.
 *
 * So fetch is replaced per test with a guard that refuses, and a test that
 * touched it fails at the end even though the promise rejection was swallowed
 * — TanStack Query turns a rejected fetch into an error state, not a failure,
 * which is exactly how the original slipped through.
 *
 * A test that needs fetch stubs it itself; that replaces this guard for the
 * duration and nothing is recorded.
 */
let unmocked: string[] = [];

beforeEach(() => {
  unmocked = [];
  globalThis.fetch = ((input: unknown) => {
    const url = String(
      typeof input === "object" && input !== null && "url" in input
        ? (input as { url: unknown }).url
        : input,
    );
    unmocked.push(url);
    return Promise.reject(new Error(`Unmocked fetch in a unit test: ${url}`));
  }) as typeof fetch;
});

afterEach(() => {
  if (unmocked.length === 0) return;
  const seen = [...new Set(unmocked)].join(", ");
  unmocked = [];
  throw new Error(
    `This test reached for the network: ${seen}. Stub it with ` +
      `vi.stubGlobal("fetch", …) — or the code under test should not be ` +
      `fetching here.`,
  );
});
