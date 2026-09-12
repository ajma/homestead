// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { cleanup, render } from "@testing-library/react";
import { type EditorDiagnostic, YamlEditor } from "@web/editor/YamlEditor";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

/**
 * jsdom does not implement contenteditable, so simulated keyboard/input events never
 * reach CodeMirror's document — nothing changes. Dispatching a transaction directly on
 * the `EditorView` is how every test here stands in for "the user typed something": the
 * `updateListener` this component installs cannot tell a real keystroke from a
 * programmatic edit, so this exercises exactly the code path a keystroke would.
 */
function typeInto(view: EditorView, text: string) {
  const from = view.state.doc.length;
  view.dispatch({ changes: { from, to: from, insert: text } });
}

function findView(container: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(container);
  if (!view) throw new Error("EditorView did not mount");
  return view;
}

describe("YamlEditor", () => {
  it("renders a .cm-editor", () => {
    const { container } = render(
      <YamlEditor value="a: 1" onChange={() => {}} diagnostics={[]} extraExtensions={[]} />,
    );
    expect(container.querySelector(".cm-editor")).toBeTruthy();
  });

  it("shows the initial value", () => {
    const { container } = render(
      <YamlEditor value="a: 1" onChange={() => {}} diagnostics={[]} extraExtensions={[]} />,
    );
    expect(findView(container).state.doc.toString()).toBe("a: 1");
  });

  it("calls onChange when the document changes", () => {
    const onChange = vi.fn();
    const { container } = render(
      <YamlEditor value="a: 1" onChange={onChange} diagnostics={[]} extraExtensions={[]} />,
    );
    typeInto(findView(container), "\nb: 2");
    expect(onChange).toHaveBeenCalledWith("a: 1\nb: 2");
  });

  it("does not fire onChange when the value prop echoes the just-typed text back in", () => {
    // This is the loop: a controlled component that dispatches every incoming `value`
    // straight back at the document re-triggers its own `onChange` the moment the parent
    // re-renders with the text it was just handed, and does that forever.
    const onChange = vi.fn();
    const { container, rerender } = render(
      <YamlEditor value="a: 1" onChange={onChange} diagnostics={[]} extraExtensions={[]} />,
    );
    typeInto(findView(container), "!");
    expect(onChange).toHaveBeenCalledTimes(1);

    rerender(
      <YamlEditor value="a: 1!" onChange={onChange} diagnostics={[]} extraExtensions={[]} />,
    );
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("replaces the document when the value prop changes to different text from outside", () => {
    const { container, rerender } = render(
      <YamlEditor value="a: 1" onChange={() => {}} diagnostics={[]} extraExtensions={[]} />,
    );
    rerender(<YamlEditor value="b: 2" onChange={() => {}} diagnostics={[]} extraExtensions={[]} />);
    expect(findView(container).state.doc.toString()).toBe("b: 2");
  });

  it("leaves the cursor where the user left it when value echoes back identical text", () => {
    // The classic symptom: a naive controlled CodeMirror resets the cursor to position 0
    // on every keystroke because it replaces the whole document even when the incoming
    // `value` already matches. Typing mid-document and checking the selection position
    // survives an echo is the direct regression test for that.
    const onChange = vi.fn();
    const { container, rerender } = render(
      <YamlEditor value="ab" onChange={onChange} diagnostics={[]} extraExtensions={[]} />,
    );
    const view = findView(container);
    view.dispatch({ changes: { from: 1, to: 1, insert: "X" }, selection: { anchor: 2 } });
    expect(view.state.doc.toString()).toBe("aXb");
    expect(view.state.selection.main.head).toBe(2);

    rerender(<YamlEditor value="aXb" onChange={onChange} diagnostics={[]} extraExtensions={[]} />);

    expect(view.state.selection.main.head).toBe(2);
  });

  it("renders a diagnostic", () => {
    const diagnostics: EditorDiagnostic[] = [
      { from: 0, to: 1, severity: "error", message: "bad key" },
    ];
    const { container } = render(
      <YamlEditor
        value="a: 1"
        onChange={() => {}}
        diagnostics={diagnostics}
        extraExtensions={[]}
      />,
    );
    expect(container.querySelector(".cm-lintRange-error")).toBeTruthy();
  });

  it("destroys the view on unmount, so its window listeners do not leak", () => {
    // `EditorView` attaches "resize"/"scroll" listeners straight onto `window` in its
    // constructor — outside the component's own DOM subtree, so removing the host node
    // from the page does not clean them up by itself. Only `view.destroy()` does. Public,
    // observable side effect rather than reaching into a private field: spy on `window`
    // itself and check every add got a matching remove.
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    try {
      const { unmount } = render(
        <YamlEditor value="a: 1" onChange={() => {}} diagnostics={[]} extraExtensions={[]} />,
      );
      const resizeAdds = addSpy.mock.calls.filter(([type]) => type === "resize").length;
      expect(resizeAdds).toBeGreaterThan(0);

      unmount();

      const resizeRemoves = removeSpy.mock.calls.filter(([type]) => type === "resize").length;
      expect(resizeRemoves).toBe(resizeAdds);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it("is read-only when asked", () => {
    const { container } = render(
      <YamlEditor
        value="a: 1"
        onChange={() => {}}
        diagnostics={[]}
        extraExtensions={[]}
        readOnly
      />,
    );
    expect(findView(container).state.readOnly).toBe(true);
    expect(container.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("false");
  });
});
