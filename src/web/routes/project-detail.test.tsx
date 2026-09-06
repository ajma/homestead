import type { ContainerState, Operation } from "@shared/projects.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetailData } from "../lib/queries.js";
import { projectDetailRoute } from "./ProjectDetail.js";

afterEach(() => vi.unstubAllGlobals());

function container(over: Partial<ContainerState> = {}): ContainerState {
  return {
    service: "web",
    name: "jellyfin-web-1",
    state: "running",
    health: null,
    exitCode: 0,
    ...over,
  };
}

function detail(over: Partial<ProjectDetailData> = {}): ProjectDetailData {
  return {
    slug: "jellyfin",
    path: "/srv/stacks/jellyfin",
    hasCompose: true,
    hasEnv: true,
    composeFile: "compose.yaml",
    model: {
      projectName: "jellyfin",
      services: [
        {
          name: "web",
          image: "jellyfin/jellyfin:10.9",
          ports: [
            {
              hostIp: "127.0.0.1",
              hostPort: 8096,
              containerPort: 8096,
              protocol: "tcp",
              loopbackOnly: true,
            },
            {
              hostIp: "0.0.0.0",
              hostPort: 1900,
              containerPort: 1900,
              protocol: "udp",
              loopbackOnly: false,
            },
          ],
          labels: {},
          app: null,
        },
      ],
      volumes: [{ key: "config", name: "jellyfin_config", external: false }],
      meta: { schemaVersion: 1, system: false },
    },
    parseError: null,
    states: [container()],
    statesError: null,
    snapshots: ["compose.yaml.2026-09-01T10-00-00Z.bak"],
    ...over,
  };
}

function operation(over: Partial<Operation> = {}): Operation {
  return {
    id: "op-1",
    slug: "jellyfin",
    kind: "up",
    status: "succeeded",
    exitCode: 0,
    startedAt: 1_000,
    finishedAt: 6_000,
    ...over,
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Stub = {
  detail?: () => Response;
  operations?: () => Response;
  post?: () => Response;
};

/** One fetch mock routed by path, because the page issues several calls. */
function stubApi(stub: Stub) {
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST")
      return (stub.post ?? (() => json(202, { operationId: "op-9" })))();
    if (String(path).endsWith("/operations"))
      return (stub.operations ?? (() => json(200, { operations: [] })))();
    return (stub.detail ?? (() => json(200, detail())))();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * The current path, rendered.
 *
 * Without this, "a bare URL lands on the overview" passes with the redirect
 * deleted: `/projects/:slug` still matches the parent route, and the parent
 * renders Overview in its sidebar whether or not the URL was ever corrected.
 */
function Path() {
  return <p>path: {useLocation().pathname}</p>;
}

function renderDetail(path = "/projects/jellyfin/overview") {
  const client = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>{projectDetailRoute}</Routes>
        <Path />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const LIFECYCLE = ["Start", "Stop", "Restart", "Pull"] as const;

describe("ProjectDetail header", () => {
  it("names the project, shows its status and carries all four controls", async () => {
    stubApi({});
    renderDetail();

    expect(
      await screen.findByRole("heading", { name: "jellyfin", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    for (const name of LIFECYCLE)
      expect(screen.getByRole("button", { name })).toBeEnabled();
    expect(
      screen.getByRole("link", { name: /back to projects/i }),
    ).toHaveAttribute("href", "/projects");
  });

  it("keeps the controls out of the collapsible Overview", async () => {
    // Content you glance at may be hidden; an action you reach for may not.
    // Restarting a stack from a phone is the primary mobile job, so the
    // controls cannot live behind the sidebar's collapse.
    stubApi({});
    renderDetail();
    const overview = await screen.findByRole("complementary", {
      name: "Overview",
    });
    for (const name of LIFECYCLE)
      expect(overview).not.toContainElement(
        screen.getByRole("button", { name }),
      );
  });

  it("reports a partly-up stack honestly", async () => {
    stubApi({
      detail: () =>
        json(
          200,
          detail({
            states: [container(), container({ service: "db", state: "dead" })],
          }),
        ),
    });
    renderDetail();
    expect(await screen.findByText("Partially running")).toBeInTheDocument();
  });
});

describe("ProjectDetail routing", () => {
  it("sends a bare project URL to the overview", async () => {
    stubApi({});
    renderDetail("/projects/jellyfin");
    expect(
      await screen.findByText("path: /projects/jellyfin/overview"),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Services" }),
    ).toBeInTheDocument();
  });

  it("keeps edit reachable as a placeholder until the editor lands", async () => {
    stubApi({});
    renderDetail("/projects/jellyfin/edit");
    expect(await screen.findByText(/not available yet/i)).toBeInTheDocument();
  });

  it("moves between tabs", async () => {
    // The e2e spec asserts the browser URL; this asserts the router state.
    stubApi({});
    renderDetail();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("tab", { name: "Edit" }));
    expect(
      await screen.findByText("path: /projects/jellyfin/edit"),
    ).toBeInTheDocument();
    expect(await screen.findByText(/not available yet/i)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

describe("Overview", () => {
  it("lists each service with its image, state and published ports", async () => {
    stubApi({});
    renderDetail();

    const services = await screen.findByRole("region", { name: "Services" });
    expect(within(services).getByText("web")).toBeInTheDocument();
    expect(
      within(services).getByText("jellyfin/jellyfin:10.9"),
    ).toBeInTheDocument();
    expect(within(services).getByText("running")).toBeInTheDocument();
  });

  it("badges a loopback port as tunnel-only and a wildcard port as LAN", async () => {
    stubApi({});
    renderDetail();

    const services = await screen.findByRole("region", { name: "Services" });
    // The distinction is the whole point of §7.4: a LAN-published port is
    // reachable by every device on the network, a loopback one is not.
    const loopback = within(services).getByText(/8096/);
    expect(
      within(loopback.closest("li") as HTMLElement).getByText("tunnel-only"),
    ).toBeInTheDocument();
    const wildcard = within(services).getByText(/1900/);
    expect(
      within(wildcard.closest("li") as HTMLElement).getByText("LAN"),
    ).toBeInTheDocument();
  });

  it("lists named volumes and snapshots", async () => {
    stubApi({});
    renderDetail();

    const volumes = await screen.findByRole("region", { name: "Volumes" });
    expect(within(volumes).getByText("jellyfin_config")).toBeInTheDocument();
    const snapshots = screen.getByRole("region", { name: "Snapshots" });
    expect(
      within(snapshots).getByText(/compose\.yaml\.2026-09-01/),
    ).toBeInTheDocument();
  });

  it("shows each recent operation's kind, status and duration", async () => {
    stubApi({
      operations: () => json(200, { operations: [operation()] }),
    });
    renderDetail();

    const recent = await screen.findByRole("region", {
      name: "Recent operations",
    });
    expect(within(recent).getByText("up")).toBeInTheDocument();
    expect(within(recent).getByText("succeeded")).toBeInTheDocument();
    expect(within(recent).getByText("5s")).toBeInTheDocument();
  });

  it("says why container status is missing instead of implying nothing runs", async () => {
    stubApi({
      detail: () =>
        json(
          200,
          detail({ states: [], statesError: "cannot connect to the daemon" }),
        ),
    });
    renderDetail();
    expect(
      await screen.findByText(/cannot connect to the daemon/),
    ).toBeInTheDocument();
  });
});

describe("a project whose compose file will not parse", () => {
  const broken = () =>
    json(
      200,
      detail({
        model: null,
        parseError: "services.web.ports must be a list",
        states: [],
        snapshots: ["compose.yaml.2026-09-01T10-00-00Z.bak"],
      }),
    );

  it("renders the parse error rather than crashing on a missing model", async () => {
    // The server answers 200 with model: null, so a view that reaches into
    // `model.services` throws on exactly the projects a user must repair.
    stubApi({ detail: broken });
    renderDetail();
    expect(
      await screen.findByText(/services\.web\.ports must be a list/),
    ).toBeInTheDocument();
  });

  it("still renders what the response does provide", async () => {
    stubApi({ detail: broken });
    renderDetail();
    // Snapshots are how the user rolls back the edit that broke it.
    const snapshots = await screen.findByRole("region", { name: "Snapshots" });
    expect(
      within(snapshots).getByText(/compose\.yaml\.2026-09-01/),
    ).toBeInTheDocument();
  });
});

describe("permissions", () => {
  it("explains a refusal once instead of retrying it", async () => {
    // The detail endpoint needs project:read, which is admin-only, so a
    // viewer's whole page is a 403.
    const fetchMock = stubApi({
      detail: () => json(403, { error: "forbidden" }),
      operations: () => json(403, { error: "forbidden" }),
    });
    renderDetail();

    expect(await screen.findByText(/do not have access/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([p]) => !String(p).endsWith("/operations"),
        ),
      ).toHaveLength(1),
    );
  });
});

describe("lifecycle controls", () => {
  it("opens the operation slot with the new id and clears it on dismiss", async () => {
    stubApi({ post: () => json(202, { operationId: "op-42" }) });
    renderDetail();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Restart" }));
    const panel = await screen.findByRole("region", { name: "Operation" });
    // Task 8's OperationPanel receives this id as a prop; Task 7 owns the slot.
    expect(panel).toHaveAttribute("data-operation-id", "op-42");

    await user.click(within(panel).getByRole("button", { name: /dismiss/i }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Operation" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("reports a 409 from another tab rather than swallowing it", async () => {
    stubApi({ post: () => json(409, { error: "operation_in_progress" }) });
    renderDetail();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /already running/i,
    );
  });

  it("disables every control while an operation is already in flight", async () => {
    stubApi({
      operations: () =>
        json(200, {
          operations: [
            operation({ status: "running", finishedAt: null, exitCode: null }),
          ],
        }),
    });
    renderDetail();

    for (const name of LIFECYCLE)
      await waitFor(() =>
        expect(screen.getByRole("button", { name })).toBeDisabled(),
      );
  });
});
