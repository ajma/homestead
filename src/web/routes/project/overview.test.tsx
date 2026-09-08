import type { ExposureSummary } from "@shared/cloudflare.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createQueryClient,
  type ProjectDetailData,
} from "../../lib/queries.js";
import { Overview } from "./Overview.js";

beforeEach(() => {
  // Overview polls operations; without a stub that reaches the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ operations: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const port = (hostPort: number, loopbackOnly = false) => ({
  hostIp: loopbackOnly ? "127.0.0.1" : "0.0.0.0",
  hostPort,
  containerPort: hostPort,
  protocol: "tcp",
  loopbackOnly,
});

const detail = (): ProjectDetailData =>
  ({
    slug: "metube",
    identity: null,
    name: "metube",
    hasCompose: true,
    hasEnv: false,
    composeFile: "compose.yaml",
    model: {
      name: "metube",
      meta: null,
      services: [
        {
          name: "metube",
          image: "ghcr.io/alexta69/metube",
          ports: [port(8081), port(9000, true)],
          labels: {},
          app: null,
        },
      ],
      volumes: [],
    },
    parseError: null,
    states: [],
    statesError: null,
    hasHomestead: true,
    snapshots: [],
  }) as unknown as ProjectDetailData;

const exposed: ExposureSummary = {
  id: "e1",
  projectSlug: "metube",
  serviceName: null,
  hostPort: 8081,
  hostname: "metube.example.com",
  scheme: "http",
  noTlsVerify: false,
  label: null,
  enabled: true,
  accessEnabled: true,
};

function renderOverview(
  exposures: ExposureSummary[],
  onExpose = vi.fn(),
  onEditExposure = vi.fn(),
) {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <MemoryRouter>
        <Overview
          slug="metube"
          detail={detail()}
          exposures={exposures}
          onExpose={onExpose}
          onEditExposure={onEditExposure}
          onEditIdentity={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { user, onExpose, onEditExposure };
}

describe("Overview exposures", () => {
  it("shows the hostname beside a port that is exposed", async () => {
    // The point of putting this here: you see whether the port you are looking
    // at is published, without leaving for another page to find out.
    renderOverview([exposed]);
    expect(await screen.findByText("metube.example.com")).toBeVisible();
  });

  it("offers to expose a port that is not", async () => {
    renderOverview([exposed]);
    // 8081 is taken; 9000 is not.
    expect(
      screen.getByRole("button", { name: /expose port 9000/i }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /expose port 8081/i }),
    ).toBeNull();
  });

  it("hands the chosen port back rather than guessing later", async () => {
    const { user, onExpose } = renderOverview([]);
    await user.click(screen.getByRole("button", { name: /expose port 8081/i }));
    expect(onExpose).toHaveBeenCalledWith(
      expect.objectContaining({ hostPort: 8081, service: "metube" }),
    );
  });

  it("edits the exposure that belongs to the port", async () => {
    const { user, onEditExposure } = renderOverview([exposed]);
    await user.click(
      screen.getByRole("button", { name: /edit metube\.example\.com/i }),
    );
    expect(onEditExposure).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e1" }),
    );
  });

  it("does not claim another project's exposure on the same port", async () => {
    // Host ports are unique on a machine, so matching on port alone is sound —
    // but an exposure recorded against a different project would be someone
    // else's row to edit.
    renderOverview([{ ...exposed, projectSlug: "other" }]);
    expect(screen.queryByText("metube.example.com")).toBeNull();
    expect(
      screen.getByRole("button", { name: /expose port 8081/i }),
    ).toBeVisible();
  });
});
