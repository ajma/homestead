import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, type RenderResult, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach } from "vitest";

/**
 * Registers on import, so only the files that actually render components pay for it.
 *
 * A global `setupFiles` entry would run this for all 471 server tests too, loading
 * React and Testing Library into every node worker — measured at roughly 70% of a small
 * server test file's runtime. Import-scoping is the same guarantee for the files that
 * need it and nothing for the files that do not.
 *
 * This call is a backstop, not the mechanism. Measured: removing it changes nothing,
 * because `@testing-library/react` registers its own `afterEach(cleanup)` on import
 * whenever a global `afterEach` exists — which `globals: true` provides. Verified by
 * running with `RTL_SKIP_AUTO_CLEANUP=true`, which is the only condition under which
 * this line does any work.
 *
 * It stays because the guarantee matters and RTL's version of it is conditional on a
 * config flag that lives somewhere else: turn off `globals` and RTL's cleanup silently
 * stops, with the symptom being `getByText` matching a node the *previous* test
 * rendered — a passing assertion about the wrong thing. Cheap insurance against a
 * change made for unrelated reasons.
 */
afterEach(cleanup);

/**
 * Every component here reads from the query cache, so a bare `render` throws.
 *
 * `retry: false` matters: the default three retries with backoff make a test that
 * asserts an error state hang until the suite timeout instead of failing.
 */
export function renderWithQuery(ui: ReactElement): RenderResult & { client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  const result = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { ...result, client };
}
