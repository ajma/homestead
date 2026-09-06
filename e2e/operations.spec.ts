import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures.js";

/** Matches HOMESTEAD_PROJECTS in playwright.config.ts. */
const PROJECTS_ROOT = "/tmp/homestead-e2e/stacks";
const PHONE = { width: 390, height: 844 };
const TOUCH_MIN = 44;

/** One projects root, one database, one daemon — so nothing here is shared. */
const suffix = randomUUID().slice(0, 8);
const STACK = `e2e-ops-${suffix}`;
const OP_ID = `e2e-op-${suffix}`;

/**
 * Nothing in this file starts a container, and nothing may.
 *
 * `POST /api/projects/:slug/:verb` and the stream it produces are both
 * answered in the browser: the lifecycle post by a `page.route` that beats the
 * suite-wide guard in `support/fixtures.ts`, and the stream by a script this
 * file writes byte for byte. Compose reconciles by project-name label rather
 * than by directory, so a stray verb here would adopt — or tear down — a stack
 * on whichever machine ran the suite.
 *
 * Scripting the stream is not only the safe choice, it is the only way to
 * reach the case that matters most: a drop and reconnect part-way through an
 * operation. A real `docker compose restart` will not produce one on demand.
 * What is under test is a browser client — reconnect handling, replay
 * de-duplication, and what survives on screen afterwards — and none of that
 * needs a daemon. The server's side is covered by
 * `src/server/routes/operations.test.ts` and, against a real daemon, by the
 * opt-in `src/server/docker/compose.integration.test.ts`.
 */
const STREAM_ROUTE = /\/api\/operations\/[^/]+\/stream(\?|$)/;

/** What the server writes before anything else; carries no event. */
const CONNECTED = ": connected\n\n";

/**
 * Chromium waits three seconds before reconnecting by default, which is most
 * of a test's budget spent doing nothing. `retry` is exactly how a server
 * shortens that, and it is short enough here that "it never reconnected" and
 * "it has not reconnected yet" cannot be confused.
 */
const RETRY = "retry: 200\n\n";

const chunk = (text: string) => `data: ${JSON.stringify({ chunk: text })}\n\n`;

const finish = (operation: unknown) =>
  `data: ${JSON.stringify({ end: true, operation })}\n\n`;

function succeeded() {
  return {
    id: OP_ID,
    slug: STACK,
    kind: "restart",
    status: "succeeded",
    exitCode: 0,
    startedAt: 1_000,
    finishedAt: 4_000,
  };
}

function failed() {
  return { ...succeeded(), status: "failed", exitCode: 1 };
}

test.beforeAll(async () => {
  await mkdir(join(PROJECTS_ROOT, STACK), { recursive: true });
  await writeFile(
    join(PROJECTS_ROOT, STACK, "compose.yaml"),
    "services:\n  web:\n    image: nginx:alpine\n",
  );
});

test.afterAll(async () => {
  await rm(join(PROJECTS_ROOT, STACK), { recursive: true, force: true });
});

type Stream = {
  /** The url of every connection answered so far, in order. */
  served: string[];
  /** What every connection from now on receives. */
  serve(body: string): void;
};

/**
 * Answers the operation stream with a body the test controls.
 *
 * The body is a *setting*, not a queue keyed on how many connections have been
 * made. React runs in StrictMode, so the very first mount opens a connection,
 * throws it away and opens another before anything has happened — a queue
 * would hand the second script entry to that throwaway and a spec asserting
 * "the reconnect was served the replay" would pass without a reconnect ever
 * occurring. Here the second body cannot be delivered until the test asks for
 * it, by which time the panel is already showing the first one's output.
 *
 * A body without a terminal frame still ends the response, which is precisely
 * a dropped connection and what makes the browser reconnect.
 */
async function scriptStream(page: Page, initial: string): Promise<Stream> {
  let body = initial;
  const served: string[] = [];
  await page.route(STREAM_ROUTE, async (route) => {
    served.push(route.request().url());
    // A connection the browser has already abandoned — StrictMode's first
    // one, or any in flight when the test ends — cannot be fulfilled, and
    // that is not a failure.
    await route
      .fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body,
      })
      .catch(() => {});
  });
  return {
    served,
    serve: (next: string) => {
      body = next;
    },
  };
}

/**
 * Answers the lifecycle post in the browser with a 202 and a known id.
 *
 * A page route takes precedence over the context route the fixture installs,
 * so this wins and the server — and the daemon behind it — is never reached.
 */
async function interceptRestart(page: Page): Promise<void> {
  await page.route(`**/api/projects/${STACK}/restart`, (route) =>
    route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ operationId: OP_ID }),
    }),
  );
}

/** Opens the detail page and starts the operation the stream belongs to. */
async function startRestart(page: Page): Promise<Locator> {
  await interceptRestart(page);
  await page.goto(`/projects/${STACK}/overview`);
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  const panel = page.getByRole("region", { name: "Operation", exact: true });
  await expect(panel).toHaveAttribute("data-operation-id", OP_ID);
  return panel;
}

test("streams the command's output and reports how it ended", async ({
  page,
}) => {
  const stream = await scriptStream(
    page,
    CONNECTED +
      RETRY +
      chunk("Container web  Restarting\n") +
      chunk("Container web  Started\n") +
      finish(succeeded()),
  );

  const panel = await startRestart(page);

  await expect(panel.getByText("Succeeded (exit 0)")).toBeVisible();
  // The stream really was opened, and for this operation. An SSE test that
  // never checks this passes just as happily with no connection at all.
  expect(stream.served.length, "the panel opened the stream").toBeGreaterThan(
    0,
  );
  expect(stream.served.at(-1)).toContain(`/api/operations/${OP_ID}/stream`);

  // Hung up on the terminal frame rather than reconnecting forever. The body
  // above sets a 200ms retry, so a panel that failed to close would have
  // opened several more connections inside this wait.
  const openedByTheEnd = stream.served.length;
  await page.waitForTimeout(1_000);
  expect(
    stream.served.length,
    "the panel closed the stream when the operation ended",
  ).toBe(openedByTheEnd);

  // A success is a one-line answer, so the log collapses out of the way…
  const log = panel.getByLabel("Operation output");
  await expect(log).toBeHidden();
  // …but it is not thrown away.
  await panel.getByRole("button", { name: "Show output" }).click();
  await expect(log).toContainText("Container web  Restarting");
  await expect(log).toContainText("Container web  Started");
});

test("a reconnect replaces the replayed log instead of doubling it", async ({
  page,
}) => {
  // The registry replays its entire buffer to every new subscriber, so a
  // client that appends shows a phone that changed networks mid-operation
  // every line twice.
  const stream = await scriptStream(
    page,
    // No terminal frame: the response ends, and the browser reconnects.
    CONNECTED + RETRY + chunk("Pulling web\n"),
  );

  const panel = await startRestart(page);
  const log = panel.getByLabel("Operation output");
  await expect(log).toContainText("Pulling web");
  const beforeReplay = stream.served.length;

  // Only now does the replay become available, so the connection that carries
  // it is necessarily one the browser made after the panel had output.
  stream.serve(
    CONNECTED + chunk("Pulling web\n") + chunk("Pulled\n") + finish(failed()),
  );

  await expect(panel.getByText("Failed (exit 1)")).toBeVisible();
  expect(
    stream.served.length,
    "the browser reconnected and was served the replay",
  ).toBeGreaterThan(beforeReplay);
  await expect(log).toContainText("Pulled");
  const text = await log.innerText();
  expect(text.match(/Pulling web/g) ?? [], text).toHaveLength(1);
});

test("a reconnect that replays nothing keeps the failure on screen", async ({
  page,
}) => {
  // The replay only happens while the operation is still in the registry's
  // `live` map. Once it has finished and been evicted — or the server has
  // restarted — `subscribe` finds no entry and ends the stream immediately,
  // with zero chunks. A client that blanks its log on `open` shows the person
  // who reconnected to read why their stack failed an empty log and a
  // terminal status.
  const stream = await scriptStream(
    page,
    CONNECTED +
      RETRY +
      chunk("Error response from daemon: port is already allocated\n"),
  );

  const panel = await startRestart(page);
  const log = panel.getByLabel("Operation output");
  await expect(log).toContainText("port is already allocated");
  const beforeEnd = stream.served.length;

  // Not one chunk: the operation has aged out of memory.
  stream.serve(CONNECTED + finish(failed()));

  await expect(panel.getByText("Failed (exit 1)")).toBeVisible();
  expect(
    stream.served.length,
    "the browser reconnected and was served an empty stream",
  ).toBeGreaterThan(beforeEnd);
  // Stays expanded on a failure, and still holds what it was shown.
  await expect(log).toBeVisible();
  await expect(log).toContainText("port is already allocated");
});

test("the panel's controls stay tappable at phone width", async ({ page }) => {
  // A failure keeps the panel expanded — its largest state, and the one a
  // phone is most likely to be holding.
  await scriptStream(
    page,
    CONNECTED +
      chunk(`${"a-really-long-unbroken-token-of-daemon-output".repeat(20)}\n`) +
      finish(failed()),
  );
  await page.setViewportSize(PHONE);

  const panel = await startRestart(page);
  await expect(panel.getByText("Failed (exit 1)")).toBeVisible();

  const controls = panel.locator("button:visible");
  const count = await controls.count();
  expect(count, "the panel has controls to measure").toBeGreaterThanOrEqual(2);
  for (let i = 0; i < count; i++) {
    const control = controls.nth(i);
    const name = (await control.textContent())?.trim() ?? "";
    const box = await control.boundingBox();
    expect(box, `${name} has no box`).not.toBeNull();
    expect(box?.height ?? 0, `${name} height`).toBeGreaterThanOrEqual(
      TOUCH_MIN,
    );
    expect(box?.width ?? 0, `${name} width`).toBeGreaterThanOrEqual(TOUCH_MIN);
  }
  // An unbreakable wall of log output must not push the page sideways.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(PHONE.width);
});
