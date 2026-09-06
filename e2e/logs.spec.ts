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
const STACK = `e2e-logs-${suffix}`;

/**
 * Nothing in this file starts a container, and nothing may.
 *
 * The brief asks for "a running project". It does not get one. `GET
 * /api/projects/:slug/logs` is answered in the browser by a script this file
 * writes byte for byte, because what is under test is the client: the toolbar,
 * pause and resume, the service filter, auto-scroll and — above all —
 * teardown. Compose reconciles by project-name label rather than by directory,
 * so a stray `up` here would adopt or tear down a stack on whichever machine
 * ran the suite, and one already slipped through once in this plan.
 *
 * Scripting the stream is also the only way to reach the cases that matter. A
 * real `docker compose logs -f` will not produce a connection that is still
 * open at the exact moment the reader navigates away, on demand. The server's
 * half of this endpoint — the permission, the `tail` bounds, the service
 * regex, and killing the child on `close` — is covered by
 * `src/server/routes/operations.test.ts`.
 */
const LOGS_ROUTE = /\/api\/projects\/[^/]+\/logs(\?|$)/;

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

/**
 * The logs stream's terminal frame carries no `operation`, unlike the
 * operations stream's.
 */
const END = `data: ${JSON.stringify({ end: true })}\n\n`;

test.beforeAll(async () => {
  await mkdir(join(PROJECTS_ROOT, STACK), { recursive: true });
  await writeFile(
    join(PROJECTS_ROOT, STACK, "compose.yaml"),
    [
      "services:",
      "  web:",
      "    image: nginx:alpine",
      "  db:",
      "    image: postgres:16-alpine",
      "",
    ].join("\n"),
  );
});

test.afterAll(async () => {
  await rm(join(PROJECTS_ROOT, STACK), { recursive: true, force: true });
});

type Stream = {
  /** The url of every connection answered so far, in order. */
  served: string[];
  /** The `?service=` of every connection, `null` when the key was absent. */
  services: (string | null)[];
  /** What every connection from now on receives. */
  serve(body: string): void;
  /**
   * Stop answering: every connection from now on is accepted and held open,
   * exactly as a real `docker compose logs -f` holds one, and never completes.
   */
  hold(): void;
  /** How many held connections are outstanding right now. */
  held(): number;
  /** Connections the *browser* aborted, which is the client hanging up. */
  aborted: string[];
};

/**
 * Answers the log stream with a body the test controls.
 *
 * The body is a *setting*, not a queue keyed on how many connections have been
 * made. React runs in StrictMode, so the first mount opens a connection,
 * throws it away and opens another before anything has happened — a queue
 * would hand the second entry to that throwaway.
 *
 * A body without a terminal frame still ends the response, which is precisely
 * a dropped connection and what makes the browser reconnect.
 */
async function scriptLogs(page: Page, initial: string): Promise<Stream> {
  let body: string | null = initial;
  const served: string[] = [];
  const services: (string | null)[] = [];
  const aborted: string[] = [];
  let outstanding = 0;

  page.on("requestfailed", (request) => {
    if (!LOGS_ROUTE.test(request.url())) return;
    // `net::ERR_ABORTED` on a request nothing else touched is the browser
    // cancelling it, which only happens when the page closes the EventSource.
    if (request.failure()?.errorText === "net::ERR_ABORTED")
      aborted.push(request.url());
  });

  await page.route(LOGS_ROUTE, async (route) => {
    const url = route.request().url();
    served.push(url);
    services.push(new URL(url).searchParams.get("service"));
    if (body === null) {
      outstanding++;
      // Held open forever. The connection ends only if the client ends it.
      await new Promise(() => {});
      return;
    }
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
    services,
    aborted,
    serve: (next: string) => {
      body = next;
    },
    hold: () => {
      body = null;
    },
    held: () => outstanding,
  };
}

function logRegion(page: Page): Locator {
  return page.getByRole("log", { name: "Log output" });
}

/** Opens the Logs tab of the fixture stack. */
async function openLogs(page: Page): Promise<Locator> {
  await page.goto(`/projects/${STACK}/logs`);
  const log = logRegion(page);
  await expect(log).toBeVisible();
  return log;
}

test("streams the container log into a mono region", async ({ page }) => {
  const stream = await scriptLogs(
    page,
    CONNECTED +
      chunk("web-1  | listening on 0.0.0.0:80\n") +
      chunk("db-1   | database system is ready\n") +
      END,
  );

  const log = await openLogs(page);

  await expect(log).toContainText("listening on 0.0.0.0:80");
  await expect(log).toContainText("database system is ready");
  // The stream really was opened. A test that never checks this passes just as
  // happily with no connection at all.
  expect(stream.served.length, "the tab opened the stream").toBeGreaterThan(0);
  await expect(log).toHaveClass(/font-mono/);
  // The reconnect notice is not furniture — it appears only when the stream
  // actually drops. Asserted here, on the one body in this file that carries a
  // terminal frame: this connection never reconnects, so the claim is a fact
  // about the component rather than a race against the browser's retry timer.
  await expect(log).not.toContainText("reconnected");

  // Built to the server's validator: `tail` inside 0..10_000, and no `service`
  // key at all while "All services" is chosen — an empty `service=` fails the
  // server's regex and comes back 400.
  const url = new URL(stream.served[stream.served.length - 1] ?? "");
  expect(url.pathname).toBe(`/api/projects/${STACK}/logs`);
  expect(Number(url.searchParams.get("tail"))).toBe(200);
  expect(stream.services, "All services omits the parameter").not.toContain("");
  expect(stream.services.at(-1)).toBeNull();
});

test("choosing a service narrows the stream, and All omits the parameter", async ({
  page,
}) => {
  const stream = await scriptLogs(
    page,
    CONNECTED + chunk("web-1  | listening\n") + END,
  );

  const log = await openLogs(page);
  await expect(log).toContainText("listening");
  const beforeFilter = stream.served.length;

  // Populated from the project's own model, so every option already satisfies
  // the server's service-name regex. There is no free-text field to type a
  // name the server would refuse with a 400 nobody can act on.
  // `exact`, because at desktop width the Overview rail is beside this tab and
  // its "Services" region would otherwise match too.
  const service = page.getByLabel("Service", { exact: true });
  await expect(service.getByRole("option")).toHaveText([
    "All services",
    "db",
    "web",
  ]);

  stream.serve(CONNECTED + chunk("db-1   | database system is ready\n") + END);
  await service.selectOption("db");

  await expect(log).toContainText("database system is ready");
  expect(
    stream.served.length,
    "picking a service reopened the stream",
  ).toBeGreaterThan(beforeFilter);
  expect(new URL(stream.served.at(-1) ?? "").searchParams.get("service")).toBe(
    "db",
  );
  // The filter really narrowed it: the unfiltered line is gone, not merely
  // joined by the filtered one.
  await expect(log).not.toContainText("web-1  | listening");

  stream.serve(CONNECTED + chunk("web-1  | listening\n") + END);
  await service.selectOption("");
  await expect(log).toContainText("listening");
  expect(stream.services.at(-1), "All services omits the parameter").toBeNull();
  expect(stream.services).not.toContain("");
});

test("the tail selector asks for a size the server accepts", async ({
  page,
}) => {
  const stream = await scriptLogs(page, CONNECTED + chunk("a line\n") + END);
  const log = await openLogs(page);
  await expect(log).toContainText("a line");

  const tail = page.getByLabel("Lines", { exact: true });
  const options = await tail.getByRole("option").allTextContents();
  expect(options.length).toBeGreaterThan(1);
  for (const option of options) {
    const value = Number(option.replace(/[^0-9]/g, ""));
    expect(Number.isFinite(value), `${option} is a number`).toBe(true);
    // `tail` is `.int().min(0).max(10_000)`; anything outside is a 400.
    expect(
      value,
      `${option} is within the server's bounds`,
    ).toBeLessThanOrEqual(10_000);
    expect(
      value,
      `${option} is within the server's bounds`,
    ).toBeGreaterThanOrEqual(0);
  }

  const before = stream.served.length;
  await tail.selectOption("1000");
  await expect
    .poll(() => stream.served.length, { timeout: 5_000 })
    .toBeGreaterThan(before);
  expect(new URL(stream.served.at(-1) ?? "").searchParams.get("tail")).toBe(
    "1000",
  );
});

test("pausing detaches the stream, and following reopens it", async ({
  page,
}) => {
  // No terminal frame, so each response ends and the browser reconnects: the
  // tab is genuinely live, and a pause that did nothing would go on collecting.
  const stream = await scriptLogs(
    page,
    CONNECTED + RETRY + chunk("web-1  | before the pause\n"),
  );

  const log = await openLogs(page);
  await expect(log).toContainText("before the pause");

  await page.getByRole("button", { name: "Pause" }).click();

  // Whatever was in flight when the button was pressed has to land first.
  await page.waitForTimeout(400);
  const servedAtPause = stream.served.length;
  stream.serve(CONNECTED + RETRY + chunk("web-1  | during the pause\n"));
  await page.waitForTimeout(1_000);

  expect(stream.served.length, "no connection is opened while paused").toBe(
    servedAtPause,
  );
  await expect(log).not.toContainText("during the pause");
  // Detaching must not blank the log: what was already on screen is the whole
  // reason someone pressed Pause.
  await expect(log).toContainText("before the pause");
  // And the UI says so, because a Pause that silently drops output would
  // mislead the person who pressed it.
  await expect(page.getByText(/not being collected/i)).toBeVisible();

  await page.getByRole("button", { name: "Follow" }).click();

  await expect(log).toContainText("during the pause");
  expect(stream.served.length, "following reopened the stream").toBeGreaterThan(
    servedAtPause,
  );
  await expect(page.getByText(/not being collected/i)).toBeHidden();
});

test("a reconnect replaces the tail and says the scrollback is gone", async ({
  page,
}) => {
  // No terminal frame, so each response ends and the browser reconnects — a
  // phone changing networks, in one line. The server re-issues `--tail=N` and
  // keeps no scrollback, so the first frame back replaces what is on screen
  // and everything older is genuinely lost.
  const stream = await scriptLogs(
    page,
    CONNECTED + RETRY + chunk("OLD-LINE-1\n") + chunk("OLD-LINE-2\n"),
  );

  const log = await openLogs(page);
  await expect(log).toContainText("OLD-LINE-1");
  await expect(log).toContainText("OLD-LINE-2");
  // No "the notice is absent yet" assertion here, deliberately. This body has
  // no terminal frame and `retry: 200`, so the browser is already reconnecting
  // every fifth of a second: whether the notice has appeared by the time the
  // assertion runs is a race against a machine under load, and it lost one
  // once the suite began running at two viewports. The same claim is made in
  // "streams the container log into a mono region", against the one body in
  // this file that ends with a terminal frame and therefore never reconnects.
  const before = stream.served.length;

  stream.serve(CONNECTED + RETRY + chunk("TAIL-ONLY\n"));

  await expect(log).toContainText("TAIL-ONLY");
  expect(
    stream.served.length,
    "the browser reconnected and was served the tail",
  ).toBeGreaterThan(before);

  // Replaced, not doubled: appending would show every retained line twice.
  const text = await log.innerText();
  expect(text.match(/TAIL-ONLY/g) ?? [], text).toHaveLength(1);
  await expect(log).not.toContainText("OLD-LINE-1");
  // And the loss is stated, in the log, where the missing lines used to be.
  await expect(log).toContainText(/the stream reconnected/i);
  await expect(log).toContainText(/last 200 lines/);
});

test("closes the log stream when the reader leaves the tab", async ({
  page,
}) => {
  // `docker compose logs -f` runs until it is killed, and the server only
  // kills it when the request closes. A hook that leaks its EventSource leaks
  // a `docker` process per visit on the user's server.
  const stream = await scriptLogs(
    page,
    CONNECTED + RETRY + chunk("web-1  | listening\n"),
  );

  const log = await openLogs(page);
  await expect(log).toContainText("listening");

  // From here the connection is accepted and never completed, which is what a
  // real follow looks like: open, with a child process behind it.
  stream.hold();
  await expect.poll(() => stream.held(), { timeout: 5_000 }).toBeGreaterThan(0);
  const abortedBefore = stream.aborted.length;

  // A client-side route change. The browser does not cancel in-flight requests
  // for one — verified — so the only thing that can end this connection is the
  // hook closing its EventSource. An assertion that merely proved "we
  // navigated away" would pass whether or not the stream closed.
  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${STACK}/overview$`));
  await expect(logRegion(page)).toHaveCount(0);

  await expect
    .poll(() => stream.aborted.length, {
      timeout: 10_000,
      message: "the open log connection was aborted by the browser",
    })
    .toBeGreaterThan(abortedBefore);
});

test("closes the log stream when the page is left entirely", async ({
  page,
}) => {
  const stream = await scriptLogs(
    page,
    CONNECTED + RETRY + chunk("web-1  | listening\n"),
  );

  const log = await openLogs(page);
  await expect(log).toContainText("listening");
  stream.hold();
  await expect.poll(() => stream.held(), { timeout: 5_000 }).toBeGreaterThan(0);
  const abortedBefore = stream.aborted.length;

  await page.getByRole("link", { name: /back to projects/i }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

  await expect
    .poll(() => stream.aborted.length, {
      timeout: 10_000,
      message: "the open log connection was aborted by the browser",
    })
    .toBeGreaterThan(abortedBefore);
});

test("the log controls stay tappable at phone width", async ({ page }) => {
  await scriptLogs(
    page,
    CONNECTED +
      chunk(`${"an-unbroken-token-of-container-output".repeat(20)}\n`) +
      END,
  );
  await page.setViewportSize(PHONE);

  const log = await openLogs(page);
  await expect(log).toContainText("an-unbroken-token");

  const controls = page.getByRole("group", { name: "Log controls" });
  const targets = controls.locator("select:visible, button:visible");
  const count = await targets.count();
  expect(count, "there are controls to measure").toBeGreaterThanOrEqual(3);
  for (let i = 0; i < count; i++) {
    const target = targets.nth(i);
    const name = (await target.getAttribute("aria-label")) ?? `control ${i}`;
    const box = await target.boundingBox();
    expect(box, `${name} has no box`).not.toBeNull();
    expect(box?.height ?? 0, `${name} height`).toBeGreaterThanOrEqual(
      TOUCH_MIN,
    );
    expect(box?.width ?? 0, `${name} width`).toBeGreaterThanOrEqual(TOUCH_MIN);
  }
  // An unbreakable wall of container output must not push the page sideways.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(PHONE.width);
});
