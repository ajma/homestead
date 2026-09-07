import { indentLess, indentMore } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { linter, lintGutter } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { forwardRef, useImperativeHandle, useRef } from "react";
import { parseDocument } from "yaml";
import { CodeEditor, type CodeEditorRef } from "./CodeEditor.js";
import { Button } from "./ui/index.js";

/**
 * Inline syntax errors as you type. `POST /api/projects/:slug/validate` stays
 * the authoritative check on save — only `docker compose config` knows the
 * real schema — but a YAML parse error is worth showing immediately.
 */
const yamlLint = linter((view) => {
  const text = view.state.doc.toString();
  const doc = parseDocument(text);
  return doc.errors.map((e) => ({
    from: Math.min(e.pos[0], text.length),
    to: Math.min(e.pos[1], text.length),
    severity: "error" as const,
    message: e.message,
  }));
});

export const ComposeEditor = forwardRef<
  CodeEditorRef,
  {
    slug: string;
    value: string;
    onChange: (next: string) => void;
    onSave: () => void;
    dirty: boolean;
  }
>(function ComposeEditor({ value, onChange, onSave, dirty }, ref) {
  const editorRef = useRef<CodeEditorRef>(null);

  useImperativeHandle(ref, () => ({
    get view() {
      return editorRef.current?.view ?? null;
    },
  }));

  const run = (command: (v: EditorView) => boolean) => () => {
    const view = editorRef.current?.view;
    if (!view) return;
    command(view);
    view.focus();
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Phone keyboards have no Tab key, and YAML is indentation-sensitive. */}
      <div
        className="flex items-center gap-2"
        role="toolbar"
        aria-label="Editor actions"
      >
        <Button onClick={run(indentMore)} aria-label="Indent">
          Indent
        </Button>
        <Button onClick={run(indentLess)} aria-label="Outdent">
          Outdent
        </Button>
        <Button onClick={onSave} disabled={!dirty} aria-label="Save">
          Save
        </Button>
      </div>
      <div
        className="overflow-auto rounded-md border border-border bg-surface"
        style={{ maxHeight: "60vh" }}
      >
        <CodeEditor
          ref={editorRef}
          value={value}
          onChange={onChange}
          initialExtensions={[yaml(), yamlLint, lintGutter()]}
        />
      </div>
    </div>
  );
});
