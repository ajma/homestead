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
 * Cleanup itself is not optional: a leaked DOM between tests makes `getByText` match a
 * node the *previous* test rendered, which reads as a passing assertion about the wrong
 * thing.
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
