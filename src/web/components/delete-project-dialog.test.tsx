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
    identity: null,
    hasCompose: true,
    hasEnv: false,
    composeFile: "compose.yaml",
    model: {
      projectName: "media",
      services: [],
      volumes: [],
    },
    parseError: null,
    states: [],
    statesError: null,
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

  it("deletes on one confirmation", async () => {
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

  it("refuses a click the disabled attribute did not stop", async () => {
    // `disabled` stops a pointer, and nothing else. The handler's own check is
    // what catches an event delivered against a stale frame, so it is tested
    // by firing past the attribute rather than through it.
    const fetchMock = mockFetch();
    const { user } = renderDialog(detail());

    await user.type(confirmField(), "medi");
    const final = screen.getByRole("button", { name: /delete project/i });
    expect(final).toBeDisabled();
    await act(async () => {
      fireEvent.click(final);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks once, for every project", async () => {
    // Deletion used to ask an adopted project twice — a directory Homestead
    // had found rather than made. That was decided by the presence of an
    // `x-homestead` block in the compose file, and both the distinction and
    // the block are gone. Typing the exact slug is the whole gate now.
    const fetchMock = mockFetch();
    const { user } = renderDialog(detail());

    expect(
      screen.queryByRole("button", { name: /continue/i }),
    ).not.toBeInTheDocument();

    await user.type(confirmField(), "media");
    await user.click(screen.getByRole("button", { name: /delete project/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
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
