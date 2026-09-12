// @vitest-environment jsdom
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { cleanup, render } from "@testing-library/react";
import { type EditorDiagnostic, YamlEditor } from "@web/editor/YamlEditor";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

// A stable reference, deliberately reused across renders in tests that need to isolate
// one prop's effect: `extraExtensions` reconfigures by identity (see YamlEditor's doc
// comment), so a fresh `[]` literal on every render would itself cause a `dispatch` and
// confound assertions aimed at a different effect.
const NO_EXTENSIONS: Extension[] = [];

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

  it("keeps a collapsed cursor's position when the external value differs only by a trailing newline", () => {
    // The equality guard (the previous test) only catches an exact echo. When the value
    // legitimately differs — even by something as small as a trailing newline, exactly
    // what a server round trip or an auto-formatter produces — the replace path used to
    // fall back to CodeMirror's default change-mapping for the selection. Mapping a
    // position through a single change that spans the *entire* document (a full
    // delete-and-insert) collapses any interior position to one of the change's two
    // boundaries, so a cursor at position 2 landed at 0 — the exact symptom the equality
    // guard exists to prevent, reached by a different route.
    const onChange = vi.fn();
    const { container, rerender } = render(
      <YamlEditor value="aaaa: 1" onChange={onChange} diagnostics={[]} extraExtensions={[]} />,
    );
    const view = findView(container);
    view.dispatch({ selection: { anchor: 2 } });
    expect(view.state.selection.main.head).toBe(2);

    rerender(
      <YamlEditor value={"aaaa: 1\n"} onChange={onChange} diagnostics={[]} extraExtensions={[]} />,
    );

    expect(view.state.doc.toString()).toBe("aaaa: 1\n");
    expect(view.state.selection.main.anchor).toBe(2);
    expect(view.state.selection.main.head).toBe(2);
  });

  it("keeps a range selection's anchor/head order (and clamps it) across an external replace", () => {
    // Reproduces the reported inversion directly: CodeMirror's default selection mapping
    // maps a non-empty range's two ends with *opposite* bias (`from` toward the end of
    // the change, `to` toward the start) so that, across a whole-document replace, a
    // forward `{ anchor: 1, head: 4 }` selection comes out the other side inverted
    // (something like `{ anchor: 7, head: 0 }` for a 7-character replacement) rather than
    // shrinking sanely. Replacing with shorter text than the selection's own head makes
    // this concrete and checkable: a correct fix clamps each side independently and keeps
    // anchor before head; a broken one can end up with anchor > head.
    const { container, rerender } = render(
      <YamlEditor value="aaaa: 1" onChange={() => {}} diagnostics={[]} extraExtensions={[]} />,
    );
    const view = findView(container);
    view.dispatch({ selection: { anchor: 1, head: 4 } });
    expect(view.state.selection.main.anchor).toBe(1);
    expect(view.state.selection.main.head).toBe(4);

    rerender(<YamlEditor value="ab" onChange={() => {}} diagnostics={[]} extraExtensions={[]} />);

    expect(view.state.doc.toString()).toBe("ab");
    expect(view.state.selection.main.anchor).toBe(1);
    expect(view.state.selection.main.head).toBe(2);
    expect(view.state.selection.main.anchor).toBeLessThanOrEqual(view.state.selection.main.head);
  });

  it("does not replace the document while an IME composition is in progress", () => {
    // Honesty note: jsdom cannot run a real IME, so this is a proxy test. It does not
    // exercise actual composed text arriving into the document — it only asserts that
    // the guard this component reads (`view.compositionStarted`, which CodeMirror's own
    // built-in `compositionstart`/`compositionend` observers on `contentDOM` maintain,
    // and which does update correctly from plain synthetic DOM events even in jsdom) is
    // respected: while it is true, an external value change must not reach the document.
    const { container, rerender } = render(
      <YamlEditor value="a: 1" onChange={() => {}} diagnostics={[]} extraExtensions={[]} />,
    );
    const view = findView(container);

    view.contentDOM.dispatchEvent(new Event("compositionstart"));
    expect(view.compositionStarted).toBe(true);

    rerender(<YamlEditor value="b: 2" onChange={() => {}} diagnostics={[]} extraExtensions={[]} />);
    expect(view.state.doc.toString()).toBe("a: 1");

    view.contentDOM.dispatchEvent(new Event("compositionend"));
    expect(view.compositionStarted).toBe(false);
  });

  it("does not re-dispatch diagnostics when a fresh array has the same content", () => {
    // Diagnostics and extraExtensions both reconfigure through a Compartment keyed on
    // the effect's dependency array, which React compares by identity. A parent that
    // constructs `diagnostics={[...]}` fresh every render — never memoising it — used to
    // cause a real `dispatch` on every single render even when nothing about the
    // diagnostics actually changed. Comparing content instead of identity fixes that.
    const { container, rerender } = render(
      <YamlEditor
        value="a: 1"
        onChange={() => {}}
        diagnostics={[]}
        extraExtensions={NO_EXTENSIONS}
      />,
    );
    const view = findView(container);
    const dispatchSpy = vi.spyOn(view, "dispatch");

    // A fresh array, `===`-distinct from the one above but identical in content.
    // `extraExtensions` stays the same reference so its own (identity-keyed, and
    // deliberately so — see Important 2 in the task report) effect can't fire and
    // confound this assertion.
    rerender(
      <YamlEditor
        value="a: 1"
        onChange={() => {}}
        diagnostics={[]}
        extraExtensions={NO_EXTENSIONS}
      />,
    );

    expect(dispatchSpy).not.toHaveBeenCalled();
    dispatchSpy.mockRestore();
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

  it("gives a diagnostic a visible gutter marker, not just an underline", () => {
    // Important 4 from the final review: without `lintGutter()`, a diagnostic existed
    // only as a `.cm-lintRange` underline in the text — reachable by mouse hover,
    // `Mod-Shift-m`, or `F8`, none of which exist on the touch platform the spec chose
    // CodeMirror for. `lintGutter()` is what adds a `cm-gutter-lint` column with a marker
    // for the line, on top of the underline the previous test already covers.
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
    expect(container.querySelector(".cm-gutter-lint")).toBeTruthy();
    expect(container.querySelector(".cm-lint-marker")).toBeTruthy();
  });

  it("puts the diagnostic's own message text in the DOM, reachable without a hover", () => {
    // The measured gap this closes: dumping the DOM for an editor with one warning found
    // the message text nowhere — only the coloured underline, a hover tooltip, and an
    // empty `aria-live` region. The lint panel (opened automatically here via
    // `autoPanel: true`, since nothing in this app ever calls `openLintPanel` — see
    // `YamlEditor`'s own extension list) renders each diagnostic's text as plain,
    // always-present DOM content: reachable on touch and by a screen reader, not only by
    // a pointer that can hover.
    const diagnostics: EditorDiagnostic[] = [
      { from: 0, to: 4, severity: "warning", message: 'Unknown key "imag".' },
    ];
    const { container } = render(
      <YamlEditor
        value="imag: nginx"
        onChange={() => {}}
        diagnostics={diagnostics}
        extraExtensions={[]}
      />,
    );
    expect(container.querySelector(".cm-panel-lint")).toBeTruthy();
    expect(container.textContent).toContain('Unknown key "imag".');
  });

  it("does not show the lint panel when there is nothing to report", () => {
    const { container } = render(
      <YamlEditor value="a: 1" onChange={() => {}} diagnostics={[]} extraExtensions={[]} />,
    );
    expect(container.querySelector(".cm-panel-lint")).toBeNull();
  });

  it("closes the lint panel again once its diagnostic is fixed", () => {
    const diagnostics: EditorDiagnostic[] = [
      { from: 0, to: 1, severity: "error", message: "bad key" },
    ];
    const { container, rerender } = render(
      <YamlEditor
        value="a: 1"
        onChange={() => {}}
        diagnostics={diagnostics}
        extraExtensions={[]}
      />,
    );
    expect(container.querySelector(".cm-panel-lint")).toBeTruthy();

    rerender(<YamlEditor value="a: 1" onChange={() => {}} diagnostics={[]} extraExtensions={[]} />);
    expect(container.querySelector(".cm-panel-lint")).toBeNull();
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
