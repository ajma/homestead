import { yaml } from "@codemirror/lang-yaml";
import { setDiagnostics } from "@codemirror/lint";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
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
 * `readOnly` and `extraExtensions` each live in their own {@link Compartment} so a prop
 * change can `reconfigure` the running view instead of tearing it down and losing undo
 * history, scroll position, and selection. Task 4 itself never changes either prop after
 * mount, but Tasks 5-8 hang lint sources and completions off `extraExtensions`, and this
 * component has no business knowing what those extensions are — only that the list can
 * change under it.
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
  extraExtensions: Extension[];
  readOnly?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartmentRef = useRef(new Compartment());
  const extraCompartmentRef = useRef(new Compartment());

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
  // no-op: nothing is dispatched, so neither the loop nor the cursor jump happens.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
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
