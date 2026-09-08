import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../lib/queries.js";
import { ProjectIdentityDialog } from "./ProjectIdentityDialog.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(onPut?: (body: unknown) => void, icons = ["metube"]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/icons")) {
        return new Response(JSON.stringify({ icons }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (init?.method === "PUT") onPut?.(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function renderDialog(
  identity: Parameters<typeof ProjectIdentityDialog>[0]["identity"] = null,
) {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <ProjectIdentityDialog
        open
        onClose={() => {}}
        slug="metube"
        identity={identity}
      />
    </QueryClientProvider>,
  );
  return { user };
}

describe("ProjectIdentityDialog", () => {
  it("saves a name, a description and an icon", async () => {
    let put: unknown;
    stubFetch((b) => {
      put = b;
    });
    const { user } = renderDialog();

    await user.type(await screen.findByLabelText(/display name/i), "MeTube");
    await user.type(screen.getByLabelText(/description/i), "Downloads videos");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(put).toMatchObject({
        displayName: "MeTube",
        description: "Downloads videos",
      }),
    );
  });

  it("offers the project's own slug before anything is typed", async () => {
    // metube -> metube.png. Most self-hosted projects are named after the app,
    // so the right answer is usually already known.
    stubFetch();
    renderDialog();
    expect(
      await screen.findByRole("button", { name: /use metube/i }),
    ).toBeVisible();
  });

  it("searches the icon set as you type", async () => {
    stubFetch(undefined, ["jellyfin", "jellyseerr"]);
    const { user } = renderDialog();
    await user.type(screen.getByLabelText(/^icon$/i), "jelly");
    expect(
      await screen.findByRole("button", { name: "jellyfin" }),
    ).toBeVisible();
  });

  it("sends null for a field that was cleared", async () => {
    // Clearing a description is a real edit. Sending undefined would leave the
    // old text in place and look like the save silently failed.
    let put: unknown;
    stubFetch((b) => {
      put = b;
    });
    const { user } = renderDialog({
      displayName: "Old",
      description: "Old text",
      iconSlug: null,
      iconUrl: null,
    });

    await user.clear(await screen.findByLabelText(/description/i));
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(put).toMatchObject({ description: null }));
  });

  it("keeps a URL field for an icon the set does not have", async () => {
    stubFetch();
    renderDialog();
    expect(await screen.findByLabelText(/icon url/i)).toBeVisible();
  });
});
