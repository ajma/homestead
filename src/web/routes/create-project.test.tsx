import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../lib/queries.js";
import { CreateProject } from "./CreateProject.js";

/**
 * The navigation is the assertion, so it is a spy rather than a real router:
 * "did the user land in the editor" is the only way to tell a stored-but-
 * invalid paste from a discarded one, and a rendered banner cannot say it.
 */
const navigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  navigate.mockReset();
});

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderCreate() {
  return render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <MemoryRouter initialEntries={["/projects/new"]}>
        <CreateProject />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("CreateProject", () => {
  it("rejects an invalid slug before any request is made", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch(201, { slug: "x", valid: true });
    renderCreate();
    await user.type(screen.getByLabelText(/name/i), "../evil");
    await user.click(screen.getByRole("button", { name: /create/i }));
    expect(await screen.findByText(/letters, digits/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a reserved name, and says why rather than calling it invalid", async () => {
    // `/projects/new` is a static route, so this project would be created and
    // then be unopenable, uneditable and undeletable from the UI. The generic
    // character hint would send the user hunting for a typo that is not there.
    const user = userEvent.setup();
    const fetchMock = mockFetch(201, { slug: "new", valid: true });
    renderCreate();
    await user.type(screen.getByLabelText(/name/i), "new");
    await user.click(screen.getByRole("button", { name: /create/i }));
    expect(await screen.findByText(/reserved/i)).toBeInTheDocument();
    expect(screen.queryByText(/letters, digits/i)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("says the name is permanent, because rename is deferred", () => {
    renderCreate();
    expect(screen.getByText(/cannot be changed later/i)).toBeInTheDocument();
  });

  it("reports a name that is already taken", async () => {
    const user = userEvent.setup();
    mockFetch(409, { error: "project_exists" });
    renderCreate();
    await user.type(screen.getByLabelText(/name/i), "media");
    await user.click(screen.getByRole("button", { name: /create/i }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });

  it("lands in the editor even when a pasted file is invalid", async () => {
    const user = userEvent.setup();
    mockFetch(201, {
      slug: "broken",
      valid: false,
      error: "services must be a mapping",
    });
    renderCreate();
    await user.type(screen.getByLabelText(/name/i), "broken");
    await user.click(screen.getByRole("radio", { name: /paste/i }));
    // `[[` types a literal `[`: user-event reads `[` as the start of a key
    // descriptor, so the unescaped brief text throws before it reaches the
    // textarea. The value under test is still `services:\n  - [nope`.
    await user.type(
      screen.getByLabelText(/compose file/i),
      "services:\n  - [[nope",
    );
    await user.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/projects/broken/edit"),
    );
  });

  it("sends the pasted content, not just the name", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch(201, { slug: "pasted", valid: true });
    renderCreate();
    await user.type(screen.getByLabelText(/name/i), "pasted");
    await user.click(screen.getByRole("radio", { name: /paste/i }));
    // `{{` types a literal `{`, for the same reason as `[[` above.
    await user.type(screen.getByLabelText(/compose file/i), "services: {{}");
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/projects");
    expect(init.method).toBe("POST");
    // The whole point of the paste path: a request that dropped `content`
    // would create an empty project and look identical on screen.
    expect(JSON.parse(String(init.body))).toEqual({
      slug: "pasted",
      source: "paste",
      content: "services: {}",
    });
  });

  it("does not send content when the source is blank", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch(201, { slug: "fresh", valid: true });
    renderCreate();
    await user.type(screen.getByLabelText(/name/i), "fresh");
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toEqual({
      slug: "fresh",
      source: "blank",
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/projects/fresh/edit"),
    );
  });

  it("clears a stale validation error once the name is fixed", async () => {
    const user = userEvent.setup();
    mockFetch(201, { slug: "good", valid: true });
    renderCreate();
    const name = screen.getByLabelText(/name/i);

    await user.type(name, ".hidden");
    await user.click(screen.getByRole("button", { name: /create/i }));
    expect(await screen.findByText(/letters, digits/i)).toBeInTheDocument();

    await user.clear(name);
    await user.type(name, "good");
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/projects/good/edit"),
    );
    // An error left on screen next to a successful navigation is a lie about
    // what just happened.
    expect(screen.queryByText(/letters, digits/i)).not.toBeInTheDocument();
  });
});
