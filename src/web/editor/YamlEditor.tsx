import { yaml } from "@codemirror/lang-yaml";
import { setDiagnostics } from "@codemirror/lint";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

export type EditorDiagnostic = {
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
};

/**
 * Replace the whole document with `nextValue`, carrying the existing selection over
 * instead of discarding it.
 *
 * A whole-document replace is a single change spanning the entire old document, so
 * CodeMirror's own change-mapping (what a normal, localized edit would use to shift the
 * selection) cannot help here: every existing position is "inside" the one big deleted
 * range, so `SelectionRange.map` collapses it to one of the change's two boundaries —
 * and does so with *different* boundaries for a range's anchor and head, which is how a
 * live `{ anchor: 1, head: 4 }` selection came out the other side as the inverted
 * `{ anchor: 7, head: 0 }`. Instead, every anchor/head is carried over as its raw
 * numeric offset and clamped to the new document's length. Clamping is monotonic, so
 * anchor and head — whichever order they started in — stay in that order; a range can
 * shrink against the new document's end but it can never invert. A collapsed caret whose
 * position still exists in the new document (this is what makes the trailing-newline
 * case work: `"aaaa: 1"` -> `"aaaa: 1\n"` only grows the document, so a caret at 2 is
 * still at 2) simply stays put.
 */
function replacePreservingSelection(view: EditorView, nextValue: string): void {
  const current = view.state.doc.toString();
  if (current === nextValue) return;
  const newLength = nextValue.length;
  const oldSelection = view.state.selection;
  const ranges = oldSelection.ranges.map((range) =>
    EditorSelection.range(Math.min(range.anchor, newLength), Math.min(range.head, newLength)),
  );
  view.dispatch({
    changes: { from: 0, to: current.length, insert: nextValue },
    selection: EditorSelection.create(ranges, oldSelection.mainIndex),
  });
}

/**
 * Shallow, field-by-field equality for diagnostic lists. `diagnostics` is plain data (no
 * identity worth preserving), but a parent that constructs the array fresh every render
 * — which is the common case for a caller that doesn't bother memoising — would
 * otherwise make the effect below call `dispatch` on every render even when nothing
 * actually changed. Comparing content instead of identity fixes that: two renders with
 * equivalent-but-distinct empty arrays now produce one `dispatch`, not two.
 */
function sameDiagnostics(a: EditorDiagnostic[] | null, b: EditorDiagnostic[]): boolean {
  if (a === b) return true;
  if (a === null || a.length !== b.length) return false;
  return a.every((diagnostic, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      diagnostic.from === other.from &&
      diagnostic.to === other.to &&
      diagnostic.severity === other.severity &&
      diagnostic.message === other.message
    );
  });
}

/**
 * `readOnly` and `extraExtensions` each live in their own {@link Compartment} so a prop
 * change can `reconfigure` the running view instead of tearing it down and losing undo
 * history, scroll position, and selection. Task 4 itself never changes either prop after
 * mount, but Tasks 5-8 hang lint sources and completions off `extraExtensions`, and this
 * component has no business knowing what those extensions are — only that the list can
 * change under it.
 *
 * `extraExtensions` is compared by *identity*, not content, in the effect that
 * reconfigures it — unlike `diagnostics`, an `Extension` is an opaque CodeMirror
 * configuration value (often a closure over a `StateField`/`ViewPlugin`); there is no
 * general way to ask two of them "are you equivalent" short of executing them. Callers
 * MUST memoise this array (`useMemo`, module-level constant, etc.) — an unmemoised
 * `extraExtensions={[...]}` reconfigures the compartment on every render. That is
 * deliberately made cheap rather than prevented: `Compartment.reconfigure` only swaps
 * which extensions are active in that slot, and never touches the document or selection,
 * so a redundant reconfigure costs one wasted `dispatch`, not correctness or state.
 */
export function YamlEditor({
  value,
  onChange,
  diagnostics,
  extraExtensions,
  readOnly = false,
}: {
  value: string;
  onChange: (next: string) => void;
  diagnostics: EditorDiagnostic[];
  /** See the memoisation note on this component's doc comment above. */
  extraExtensions: Extension[];
  readOnly?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartmentRef = useRef(new Compartment());
  const extraCompartmentRef = useRef(new Compartment());
  const lastDiagnosticsRef = useRef<EditorDiagnostic[] | null>(null);

  // A ref, not a dependency: reading the latest `onChange` through here means the
  // `updateListener` extension below is built exactly once, in the mount effect. Putting
  // `onChange` in that effect's dependency array instead would recreate the `EditorView`
  // — or force a second effect to swap the listener extension — on every render in which
  // the caller passes a new closure, which is every render for a caller that does not
  // memoize it.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Same trick for the props that seed the *initial* state. The mount effect below reads
  // these once, through a ref, precisely so it can carry an empty dependency array
  // honestly instead of needing a lint suppression for values it deliberately does not
  // react to — every later change reaches the live view through dispatch/reconfigure in
  // the effects further down, not by re-running this one.
  const initialValueRef = useRef(value);
  const initialReadOnlyRef = useRef(readOnly);
  const initialExtraExtensionsRef = useRef(extraExtensions);

  // Created once, destroyed once. Every prop reaches this instance through
  // `dispatch`/`reconfigure` in the effects below, never by rebuilding it — rebuilding on
  // every keystroke would drop undo history and reset scroll and selection on top of
  // being needlessly expensive.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const readOnlyCompartment = readOnlyCompartmentRef.current;
    const extraCompartment = extraCompartmentRef.current;
    const initialReadOnly = initialReadOnlyRef.current;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          basicSetup,
          yaml(),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          readOnlyCompartment.of([
            EditorState.readOnly.of(initialReadOnly),
            EditorView.editable.of(!initialReadOnly),
          ]),
          extraCompartment.of(initialExtraExtensionsRef.current),
        ],
      }),
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // The bug this guards against: a controlled CodeMirror that blindly dispatches the
  // incoming `value` back into the document on every render dispatches an "echo" right
  // after the user's own keystroke produced that same value, which both re-fires
  // `onChange` (a feedback loop) and replaces the whole document (resetting the cursor to
  // wherever the replacement leaves it, reported by users as "the cursor jumps to the
  // start while I type"). Comparing against the live document first makes that echo a
  // no-op: nothing is dispatched, so neither the loop nor the cursor jump happens. When
  // the value genuinely differs, `replacePreservingSelection` still has to replace the
  // whole document (this component isn't told what changed, only what the new text is)
  // but keeps the user's selection alive across that replacement instead of discarding
  // it — see that function's doc comment.
  //
  // `view.compositionStarted` is CodeMirror's own record of whether the user is mid-IME
  // composition (its built-in `compositionstart`/`compositionend` observers on
  // `contentDOM` maintain it, which is also what makes the guard testable at all in
  // jsdom — see the test for the caveat on what that test actually proves). Replacing
  // the document out from under an in-progress composition would yank the not-yet-
  // committed composed text out from under the input method, so the sync is skipped
  // entirely while composing. Known trade-off: if `value` changes while composing and
  // never changes again afterward, that particular update stays unapplied until it
  // does — there is no separate "flush on compositionend" path.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.compositionStarted) return;
    replacePreservingSelection(view, value);
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (sameDiagnostics(lastDiagnosticsRef.current, diagnostics)) return;
    lastDiagnosticsRef.current = diagnostics;
    view.dispatch(setDiagnostics(view.state, diagnostics));
  }, [diagnostics]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: extraCompartmentRef.current.reconfigure(extraExtensions) });
  }, [extraExtensions]);

  return (
    <div
      ref={hostRef}
      className="overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800"
    />
  );
}
