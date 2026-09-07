import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient, type ProjectDetailData } from "../lib/queries.js";
import { DeleteProjectDialog } from "./DeleteProjectDialog.js";

const navigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  navigate.mockReset();
});

/** Records every request so "was anything sent?" is answerable, not assumed. */
function mockFetch(status = 200, body: unknown = { ok: true }) {
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

function detail(over: Partial<ProjectDetailData> = {}): ProjectDetailData {
  return {
    slug: "media",
    hasCompose: true,
    hasEnv: false,
    composeFile: "compose.yaml",
    model: {
      projectName: "media",
      services: [],
      volumes: [],
      meta: { schemaVersion: 1, system: false },
    },
    parseError: null,
    states: [],
    statesError: null,
    hasHomestead: true,
    snapshots: [],
    ...over,
  };
}

function renderDialog(data: ProjectDetailData) {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <MemoryRouter>
        <DeleteProjectDialog open onClose={onClose} detail={data} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { user, onClose };
}

const confirmField = () => screen.getByLabelText(/type .* to confirm/i);
const dangerButton = () =>
  screen.getByRole("button", { name: /delete project|continue/i });

describe("DeleteProjectDialog", () => {
  it("will not delete until the slug is typed exactly", async () => {
    const fetchMock = mockFetch();
    const { user } = renderDialog(detail());

    expect(dangerButton()).toBeDisabled();
    // A near miss is still a miss — this is the whole point of the field.
    await user.type(confirmField(), "medi");
    expect(dangerButton()).toBeDisabled();
    await user.click(dangerButton());
    expect(fetchMock).not.toHaveBeenCalled();

    await user.type(confirmField(), "a");
    expect(dangerButton()).toBeEnabled();
  });

  it("deletes a Homestead-created project on one confirmation", async () => {
    const fetchMock = mockFetch();
    const { user, onClose } = renderDialog(detail());

    await user.type(confirmField(), "media");
    await user.click(screen.getByRole("button", { name: /delete project/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/projects/media");
    expect(init.method).toBe("DELETE");
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/projects"));
    expect(onClose).toHaveBeenCalled();
  });

  it("asks an adopted project twice, and sends nothing on the first yes", async () => {
    const fetchMock = mockFetch();
    const { user } = renderDialog(detail({ hasHomestead: false }));

    // The provenance is said out loud, not just acted on.
    expect(screen.getByText(/homestead did not create/i)).toBeInTheDocument();

    await user.type(confirmField(), "media");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    // The assertion that matters: the first yes must reach nothing.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: /really delete media\?/i }),
    ).toBeInTheDocument();

    // Advancing cleared the field, so the second yes is typed as well.
    await user.type(confirmField(), "media");
    await user.click(screen.getByRole("button", { name: /delete project/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("makes the user type the slug again for the second confirmation", async () => {
    const fetchMock = mockFetch();
    const { user } = renderDialog(detail({ hasHomestead: false }));

    await user.type(confirmField(), "media");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    // Advancing clears the field, so the final confirm starts locked. A
    // second prompt that arrives pre-satisfied is a click-through, not a
    // confirmation.
    expect(confirmField()).toHaveValue("");
    expect(
      screen.getByRole("button", { name: /delete project/i }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /delete project/i }));
    expect(fetchMock).not.toHaveBeenCalled();

    await user.type(confirmField(), "media");
    await user.click(screen.getByRole("button", { name: /delete project/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("survives an impatient double-tap on the first confirmation", async () => {
    // A phone, a NAS that takes a moment, and a second tap. Both steps render
    // into the same place, so without a cleared field AND a fresh element the
    // second click of one gesture lands on the final confirm and deletes.
    const fetchMock = mockFetch();
    const { user } = renderDialog(detail({ hasHomestead: false }));

    await user.type(confirmField(), "media");
    await user.dblClick(screen.getByRole("button", { name: /continue/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    // And it is genuinely still waiting on the user, not merely slow.
    expect(
      screen.getByRole("heading", { name: /really delete media\?/i }),
    ).toBeInTheDocument();
    expect(confirmField()).toHaveValue("");
    expect(
      screen.getByRole("button", { name: /delete project/i }),
    ).toBeDisabled();
  });

  it("refuses Enter on a near miss, which no disabled attribute is guarding", async () => {
    // Enter in the field never consults the button's `disabled`, so the check
    // inside the handler is the only gate on this path. Delete that line and
    // this near miss deletes the project.
    const fetchMock = mockFetch();
    const { user } = renderDialog(detail());

    await user.type(confirmField(), "medi{Enter}");
    // Flush the mutation's microtask: asserting straight after the keypress
    // would pass even if the request had been issued.
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();

    await user.type(confirmField(), "a{Enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("advances rather than deletes when Enter lands on an adopted project", async () => {
    const fetchMock = mockFetch();
    const { user } = renderDialog(detail({ hasHomestead: false }));

    await user.type(confirmField(), "media{Enter}");
    await act(async () => {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: /really delete media\?/i }),
    ).toBeInTheDocument();
  });

  it("refuses a click the disabled attribute did not stop", async () => {
    // `disabled` stops a pointer, and nothing else. Belt and braces with the
    // handler's own check, for an event delivered against a stale frame.
    const fetchMock = mockFetch();
    const { user } = renderDialog(detail({ hasHomestead: false }));

    await user.type(confirmField(), "media");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    const final = screen.getByRole("button", { name: /delete project/i });
    expect(final).toBeDisabled();
    await act(async () => {
      fireEvent.click(final);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces the confirm button rather than relabelling the one under the pointer", async () => {
    // The second half of the double-tap fix. If React reuses the node, the
    // element the user is already touching — or has focus on — silently
    // becomes the destructive one, so the same gesture that advanced the
    // dialog can also fire it.
    const { user } = renderDialog(detail({ hasHomestead: false }));

    await user.type(confirmField(), "media");
    const advance = screen.getByRole("button", { name: /continue/i });
    advance.focus();
    await user.click(advance);

    const final = screen.getByRole("button", { name: /delete project/i });
    expect(final).not.toBe(advance);
    // Nothing destructive inherits the focus the previous step held.
    expect(document.activeElement).not.toBe(final);
  });

  it("names the volumes it leaves behind and the command to remove them", () => {
    mockFetch();
    renderDialog(
      detail({
        model: {
          projectName: "media",
          services: [],
          volumes: [
            { key: "config", name: "media_config", external: false },
            { key: "cache", name: "media_cache", external: false },
            // Owned elsewhere: offering it would tell the user to delete
            // another stack's data.
            { key: "shared", name: "nas_shared", external: true },
          ],
          meta: { schemaVersion: 1, system: false },
        },
      }),
    );

    expect(screen.getByText(/2 named volumes are left behind/i)).toBeVisible();
    const commands = screen.getByText(/docker volume rm/);
    expect(commands).toHaveTextContent("docker volume rm media_config");
    expect(commands).toHaveTextContent("docker volume rm media_cache");
    expect(commands).not.toHaveTextContent("nas_shared");
  });

  it("says nothing about volumes when there are none to leave behind", () => {
    mockFetch();
    renderDialog(detail());
    expect(screen.queryByText(/left behind/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/docker volume rm/)).not.toBeInTheDocument();
  });

  it("stays open and explains itself when the delete fails", async () => {
    mockFetch(500, { error: "boom" });
    const { user, onClose } = renderDialog(detail());

    await user.type(confirmField(), "media");
    await user.click(screen.getByRole("button", { name: /delete project/i }));

    expect(await screen.findByText(/could not delete/i)).toBeInTheDocument();
    // A failed delete that closed the dialog and navigated away would tell the
    // user the project is gone when it is still there.
    expect(navigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("tells the user to wait when the server refuses a delete as busy", async () => {
    // The server now holds the per-project lock across `down` *and* `rm -rf`,
    // so a delete racing an `up` from another tab comes back 409. That is not
    // a failure to apologise for — it is "wait", and "409
    // operation_in_progress" does not say so.
    mockFetch(409, { error: "operation_in_progress" });
    const { user, onClose } = renderDialog(detail());

    await user.type(confirmField(), "media");
    await user.click(screen.getByRole("button", { name: /delete project/i }));

    expect(
      await screen.findByText(/another operation is running for media/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/could not delete/i)).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
