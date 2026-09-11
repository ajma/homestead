// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { JobOutput } from "@web/components/JobOutput";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no EventSource. Same double as `use-sse-text.test.tsx` and the sibling tab
// tests (`LogsTab.test.tsx`, `ContainersTab.test.tsx`).
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== fn),
    );
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    const init = data === undefined ? {} : { data: JSON.stringify(data) };
    for (const fn of this.listeners.get(type) ?? []) {
      fn(new MessageEvent(type, init));
    }
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("JobOutput", () => {
  it("opens a stream against the job's own url", () => {
    render(<JobOutput jobId="j1" onDone={vi.fn()} />);
    expect(FakeEventSource.instances[0]?.url).toBe("/api/jobs/j1/stream");
  });

  it("renders output as it streams in", async () => {
    render(<JobOutput jobId="j1" onDone={vi.fn()} />);

    act(() => {
      FakeEventSource.instances[0]?.emit("output", { text: "pulling image", stream: "stdout" });
    });

    await waitFor(() => expect(screen.getByText(/pulling image/)).toBeTruthy());
  });

  it("calls onDone exactly once when the stream finishes", async () => {
    const onDone = vi.fn();
    render(<JobOutput jobId="j1" onDone={onDone} />);

    act(() => {
      FakeEventSource.instances[0]?.emit("output", { text: "done soon", stream: "stdout" });
      FakeEventSource.instances[0]?.emit("done", { status: "succeeded", exitCode: 0 });
    });

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    // A re-render after done (a new output chunk should not arrive post-done in practice,
    // but nothing here should call onDone a second time if one does) does not refire it.
    act(() => {
      FakeEventSource.instances[0]?.emit("output", { text: "more", stream: "stdout" });
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("shows the stream's error message", async () => {
    render(<JobOutput jobId="j1" onDone={vi.fn()} />);

    act(() => {
      FakeEventSource.instances[0]?.emit("error", {
        code: "stream_failed",
        message: "The stream ended unexpectedly.",
      });
    });

    await waitFor(() => expect(screen.getByText("The stream ended unexpectedly.")).toBeTruthy());
  });

  it("closes the stream on unmount", () => {
    const { unmount } = render(<JobOutput jobId="j1" onDone={vi.fn()} />);
    unmount();
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });
});
