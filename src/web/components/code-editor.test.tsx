import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CodeEditor } from "./CodeEditor.js";

describe("CodeEditor", () => {
  // CodeMirror needs real DOM measurement APIs that jsdom lacks.
  // Mock getClientRects to prevent errors during editor measurement.
  beforeAll(() => {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as DOMRectList;
    Range.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    });
  });

  it("renders the initial value", async () => {
    render(<CodeEditor value="hello world" onChange={() => {}} />);
    expect(await screen.findByText(/hello world/)).toBeInTheDocument();
  });

  it("calls onChange when content is edited", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CodeEditor value="initial" onChange={onChange} />);

    // CodeMirror creates a contenteditable element
    const editor = screen.getByRole("textbox");
    await user.click(editor);
    await user.keyboard(" text");

    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls.at(-1);
    if (!lastCall) throw new Error("onChange was not called");
    expect(lastCall[0]).toContain("initial");
    expect(lastCall[0]).toContain("text");
  });

  it("reconciles external value changes without recreating the view", async () => {
    const { rerender } = render(
      <CodeEditor value="first" onChange={() => {}} />,
    );

    expect(await screen.findByText(/first/)).toBeInTheDocument();

    rerender(<CodeEditor value="second" onChange={() => {}} />);

    expect(await screen.findByText(/second/)).toBeInTheDocument();
    expect(screen.queryByText(/first/)).not.toBeInTheDocument();
  });

  it("does not call onChange during external reconciliation", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CodeEditor value="first" onChange={onChange} />,
    );

    onChange.mockClear();
    rerender(<CodeEditor value="second" onChange={onChange} />);

    // External updates should not trigger onChange
    expect(onChange).not.toHaveBeenCalled();
  });
});
