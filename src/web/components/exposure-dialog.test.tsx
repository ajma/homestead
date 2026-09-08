import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../lib/queries.js";
import { ExposureDialog, type PortOption } from "./ExposureDialog.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ZONES = { zones: [{ id: "z1", name: "example.com" }] };

function stubFetch(onPost?: (body: unknown) => void) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/cloudflare/zones")) {
        return new Response(JSON.stringify(ZONES), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (init?.method === "POST") {
        onPost?.(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: "e1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const PORTS: PortOption[] = [
  {
    service: "metube",
    hostIp: "0.0.0.0",
    hostPort: 8081,
    containerPort: 8081,
    protocol: "tcp",
    loopbackOnly: false,
  },
  {
    service: "metube",
    hostIp: "127.0.0.1",
    hostPort: 9000,
    containerPort: 9000,
    protocol: "tcp",
    loopbackOnly: true,
  },
];

function renderDialog(props: Partial<Parameters<typeof ExposureDialog>[0]>) {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <ExposureDialog
        open
        onClose={() => {}}
        exposure={null}
        {...(props as Record<string, unknown>)}
      />
    </QueryClientProvider>,
  );
  return { user };
}

describe("ExposureDialog inside a project", () => {
  it("offers the project's published ports rather than a free-text box", async () => {
    // The project already knows its ports. Typing one invites a number nothing
    // listens on, which then fails as a tunnel 502 rather than a form error.
    stubFetch();
    renderDialog({ projectSlug: "metube", ports: PORTS });

    const port = await screen.findByLabelText(/^port$/i);
    expect(port.tagName).toBe("SELECT");
    expect(
      await screen.findByRole("option", { name: /8081/ }),
    ).toBeInTheDocument();
  });

  it("marks a loopback-only port rather than hiding it", async () => {
    // Loopback ports are the best candidates: the tunnel reaches them and the
    // LAN does not. Saying so beats omitting them.
    stubFetch();
    renderDialog({ projectSlug: "metube", ports: PORTS });
    expect(
      await screen.findByRole("option", { name: /9000.*loopback/i }),
    ).toBeInTheDocument();
  });

  it("submits the project it was opened from", async () => {
    let posted: unknown;
    stubFetch((b) => {
      posted = b;
    });
    const { user } = renderDialog({ projectSlug: "metube", ports: PORTS });

    await user.type(await screen.findByLabelText(/^name$/i), "metube");
    await user.selectOptions(
      await screen.findByLabelText(/^domain$/i),
      "example.com",
    );
    await user.selectOptions(await screen.findByLabelText(/^port$/i), "8081");
    await user.click(screen.getByRole("button", { name: /add|save|create/i }));

    expect(posted).toMatchObject({
      projectSlug: "metube",
      hostPort: 8081,
      hostname: "metube.example.com",
    });
  });

  it("keeps a free-text port when opened without a project", async () => {
    // The standalone page exposes bare host services, which have no project to
    // enumerate ports from.
    stubFetch();
    renderDialog({});
    const port = await screen.findByLabelText(/^port$/i);
    expect(port.tagName).toBe("INPUT");
  });
});
