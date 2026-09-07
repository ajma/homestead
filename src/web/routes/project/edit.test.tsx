import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryRouter,
  Link,
  RouterProvider,
  useLocation,
} from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../lib/queries.js";
import { Edit } from "./Edit.js";

afterEach(() => vi.unstubAllGlobals());

const COMPOSE = "services:\n  web:\n    image: nginx:alpine\n";
/** A comment and a blank line, because those are what a naive editor eats. */
const ENV = "# set by hand, do not lose me\n\nTZ=UTC\nPUID=1000\n";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Every request, so a save can be inspected rather than assumed. */
type Calls = { path: string; init?: RequestInit }[];

function stubFiles({ env = ENV }: { env?: string | null } = {}): Calls {
  const calls: Calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path: String(path), init });
      if (init?.method === "PUT") return json(200, { ok: true });
      if (String(path).endsWith("/file/compose"))
        return json(200, { content: COMPOSE });
      if (String(path).endsWith("/file/env"))
        return env === null
          ? json(404, { error: "not_found" })
          : json(200, { content: env });
      return json(200, {});
    }),
  );
  return calls;
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderEdit() {
  const user = userEvent.setup();
  const router = createMemoryRouter(
    [
      {
        path: "/projects/:slug/edit",
        element: (
          <>
            <Where />
            <Link to="/projects">Back to projects</Link>
            <Edit />
          </>
        ),
      },
      { path: "/projects", element: <p>the project list</p> },
    ],
    { initialEntries: ["/projects/media/edit"] },
  );
  render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return user;
}

const toEnv = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("radio", { name: ".env" }));
const toCompose = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("radio", { name: "Compose" }));

/** Wait for both file reads to land before touching anything. */
async function ready() {
  await screen.findByRole("region", { name: "Edit project files" });
}

describe("Edit", () => {
  it("writes back the whole .env, comments and blank lines included", async () => {
    const calls = stubFiles();
    const user = renderEdit();
    await ready();
    await toEnv(user);

    const tz = await screen.findByLabelText("Value for TZ");
    await user.clear(tz);
    await user.type(tz, "Europe/Oslo");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(calls.some((c) => c.init?.method === "PUT")).toBe(true),
    );
    const put = calls.find((c) => c.init?.method === "PUT");
    expect(put?.path).toBe("/api/projects/media/file/env");
    const { content } = JSON.parse(String(put?.init?.body));
    // The round-trip requirement: one changed value, everything else byte
    // for byte. A rebuild-from-entries editor passes "TZ changed" and fails
    // exactly here.
    expect(content).toBe(
      "# set by hand, do not lose me\n\nTZ=Europe/Oslo\nPUID=1000\n",
    );
  });

  it("offers to create a .env that does not exist yet", async () => {
    const calls = stubFiles({ env: null });
    const user = renderEdit();
    await ready();
    await toEnv(user);

    expect(await screen.findByText(/no \.env file/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /create \.env/i }));

    // An empty new file is itself a change worth saving, so the form appears
    // and Save is live without typing anything.
    const newKey = await screen.findByLabelText(/key for the new variable/i);
    await user.type(newKey, "TZ");
    await user.click(screen.getByRole("button", { name: /add variable/i }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(calls.some((c) => c.init?.method === "PUT")).toBe(true),
    );
    const put = calls.find((c) => c.init?.method === "PUT");
    expect(put?.path).toBe("/api/projects/media/file/env");
    expect(JSON.parse(String(put?.init?.body)).content).toBe("TZ=\n");
  });

  it("asks before a Compose ↔ .env switch throws the buffer away", async () => {
    stubFiles();
    const user = renderEdit();
    await ready();
    await toEnv(user);

    const tz = await screen.findByLabelText("Value for TZ");
    await user.clear(tz);
    await user.type(tz, "Europe/Oslo");

    await toCompose(user);

    // The router never sees this navigation, so nothing but this guard is
    // between the user and a silently discarded buffer.
    expect(
      screen.getByRole("alertdialog", { name: /discard unsaved changes/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /keep editing/i }));

    // Still on .env, still holding the edit.
    expect(await screen.findByLabelText("Value for TZ")).toHaveValue(
      "Europe/Oslo",
    );
  });

  it("really does discard the buffer when the user says so", async () => {
    stubFiles();
    const user = renderEdit();
    await ready();
    await toEnv(user);

    const tz = await screen.findByLabelText("Value for TZ");
    await user.clear(tz);
    await user.type(tz, "Europe/Oslo");

    await toCompose(user);
    await user.click(screen.getByRole("button", { name: /discard changes/i }));
    await toEnv(user);

    // "Discard" that kept the buffer would be a lie the next screen tells.
    expect(await screen.findByLabelText("Value for TZ")).toHaveValue("UTC");
  });

  it("does not ask when there is nothing unsaved to lose", async () => {
    stubFiles();
    const user = renderEdit();
    await ready();
    await toEnv(user);
    await toCompose(user);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("blocks leaving the route with unsaved work, and releases on discard", async () => {
    stubFiles();
    const user = renderEdit();
    await ready();
    await toEnv(user);

    const tz = await screen.findByLabelText("Value for TZ");
    await user.clear(tz);
    await user.type(tz, "Europe/Oslo");

    await user.click(screen.getByRole("link", { name: /back to projects/i }));
    // Where the user ended up is the assertion; a dialog alone proves nothing.
    expect(screen.getByTestId("where")).toHaveTextContent(
      "/projects/media/edit",
    );
    expect(screen.queryByText("the project list")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /discard changes/i }));
    expect(screen.getByText("the project list")).toBeInTheDocument();
  });

  it("lets a clean editor leave without a word", async () => {
    stubFiles();
    const user = renderEdit();
    await ready();
    await user.click(screen.getByRole("link", { name: /back to projects/i }));
    expect(screen.getByText("the project list")).toBeInTheDocument();
  });
});
