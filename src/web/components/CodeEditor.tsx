import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import type { Extension } from "@codemirror/state";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export interface CodeEditorRef {
  view: EditorView | null;
}

/**
 * Language-agnostic CodeMirror wrapper. Handles mount/unmount lifecycle and
 * reconciles external value changes without destroying cursor or undo history.
 * Used by ComposeEditor (YAML) and the raw .env editor (Task 9).
 */
export const CodeEditor = forwardRef<
  CodeEditorRef,
  {
    value: string;
    onChange: (next: string) => void;
    /** Extensions are captured once at mount and are not reactive. */
    initialExtensions?: Extension[];
    className?: string;
  }
>(function CodeEditor(
  { value, onChange, initialExtensions = [], className = "" },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const isReconciling = useRef(false);
  onChangeRef.current = onChange;

  useImperativeHandle(ref, () => ({
    get view() {
      return view.current;
    },
  }));

  // Mount once. `value` is the initial document; later external changes are
  // reconciled by the effect below, because recreating the view on every
  // keystroke would destroy the cursor and the undo history.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount once, reconcile externally
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !isReconciling.current) {
              onChangeRef.current(u.state.doc.toString());
            }
          }),
          EditorView.theme({
            "&": { fontSize: "14px" },
            ".cm-content": { fontFamily: "monospace" },
          }),
          ...initialExtensions,
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    // Preserve cursor position across external updates, clamped to new length.
    const selection = editor.state.selection.main;
    const newLength = value.length;
    isReconciling.current = true;
    editor.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: {
        anchor: Math.min(selection.anchor, newLength),
        head: Math.min(selection.head, newLength),
      },
    });
    isReconciling.current = false;
  }, [value]);

  return <div ref={host} className={className} />;
});
