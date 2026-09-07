import { forceLinting } from "@codemirror/lint";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CodeEditorRef } from "./CodeEditor.js";
import { ComposeEditor } from "./ComposeEditor.js";

const props = {
  slug: "media",
  value: "services:\n  web:\n    image: nginx\n",
  onChange: () => {},
  onSave: () => {},
  dirty: false,
};

describe("ComposeEditor", () => {
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

  it("renders the document", async () => {
    render(<ComposeEditor {...props} />);
    expect(await screen.findByText(/image: nginx/)).toBeInTheDocument();
  });

  it("offers indent, outdent and save without a physical keyboard", () => {
    // Spec §4.1: phone keyboards have no Tab key and YAML is
    // indentation-sensitive, so these must be reachable by touch.
    render(<ComposeEditor {...props} />);
    for (const name of [/indent/i, /outdent/i, /save/i])
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
  });

  it("indents the current line when the toolbar button is pressed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ComposeEditor {...props} value={"a: 1\n"} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /indent/i }));
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls.at(-1);
    if (!lastCall) throw new Error("onChange was not called");
    expect(lastCall[0]).toMatch(/^\s+a: 1/);
  });

  it("calls onSave from the toolbar", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<ComposeEditor {...props} dirty onSave={onSave} />);
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalled();
  });

  it("disables save when there is nothing to save", () => {
    render(<ComposeEditor {...props} dirty={false} />);
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("reports YAML parse errors through the inline linter", async () => {
    const ref = createRef<CodeEditorRef>();
    // Invalid YAML: missing closing quote
    render(
      <ComposeEditor
        {...props}
        ref={ref}
        value='services:\n  app:\n    image: "broken'
      />,
    );
    const view = ref.current?.view;
    if (!view) throw new Error("EditorView not available");

    // Force linting to run and wait for it to complete
    await forceLinting(view);

    // Find the LintState in the state fields and verify it has diagnostics
    const state = view.state;
    let lintState: unknown = null;
    // @ts-expect-error - accessing internal state.values to verify linter
    for (const field of state.values) {
      if (
        field &&
        typeof field === "object" &&
        "diagnostics" in field &&
        "selected" in field
      ) {
        lintState = field;
        break;
      }
    }

    if (!lintState) {
      throw new Error("LintState not found in editor state");
    }

    // Check that diagnostics exist (RangeSet with chunks)
    // biome-ignore lint/suspicious/noExplicitAny: LintState shape is internal
    const diagnostics = (lintState as any).diagnostics;
    expect(diagnostics.chunkPos).toBeDefined();
    expect(diagnostics.chunk).toBeDefined();
    // A RangeSet with diagnostics has non-empty chunk arrays
    expect(diagnostics.chunk.length).toBeGreaterThan(0);
  });
});
