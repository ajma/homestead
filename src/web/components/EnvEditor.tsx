import {
  addEntry,
  type EnvLine,
  isSecretKey,
  parseEnv,
  removeEntry,
  serializeEnv,
  setEntryValue,
} from "@shared/env.js";
import { useState } from "react";
import { CodeEditor } from "./CodeEditor.js";
import {
  Button,
  EmptyState,
  IconButton,
  Input,
  SegmentedControl,
} from "./ui/index.js";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_HINT =
  "Keys may contain letters, digits and underscores, and may not start with a digit.";

export function EnvEditor({
  value,
  onChange,
  onSave,
  dirty,
}: {
  /** `null` means the project has no `.env` yet. */
  value: string | null;
  onChange: (next: string) => void;
  onSave: () => void;
  dirty: boolean;
}) {
  const [view, setView] = useState<"form" | "raw">("form");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [newKey, setNewKey] = useState("");

  if (value === null)
    return (
      <EmptyState
        title="No .env file"
        description="This project has no .env yet. Creating one lets compose substitute variables into its file."
        action={<Button onClick={() => onChange("")}>Create .env</Button>}
      />
    );

  const lines = parseEnv(value);
  const entries = lines.filter(
    (l): l is Extract<EnvLine, { kind: "entry" }> => l.kind === "entry",
  );
  // Every write serialises the FULL line list, so comments, blanks and lines
  // the parser does not model survive untouched. Rebuilding from `entries`
  // would delete them on first save — the failure §4.2 exists to prevent.
  const emit = (next: EnvLine[]) => onChange(serializeEnv(next));

  // Detect duplicate keys: .env permits them; compose takes the last value.
  const keyCounts = new Map<string, number>();
  for (const entry of entries) {
    keyCounts.set(entry.key, (keyCounts.get(entry.key) ?? 0) + 1);
  }
  const keyIndices = new Map<string, number>();

  const keyError = newKey !== "" && !KEY_RE.test(newKey) ? KEY_HINT : null;
  const errorId = "new-key-error";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <SegmentedControl
          items={[
            { id: "form", label: "Form" },
            { id: "raw", label: "Raw" },
          ]}
          value={view}
          onChange={(v) => setView(v as "form" | "raw")}
        />
        <Button onClick={onSave} disabled={!dirty}>
          Save
        </Button>
      </div>

      {view === "raw" ? (
        // The escape hatch §4.2 requires: multi-line values and exotic quoting
        // stay editable rather than becoming unreachable through the form.
        <CodeEditor
          value={value}
          onChange={onChange}
          className="min-h-64 rounded-md border border-border"
        />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {entries.map((entry, index) => {
              const secret = isSecretKey(entry.key);
              const shown = revealed[entry.key] === true;
              const count = keyCounts.get(entry.key) ?? 1;
              const occurrence = (keyIndices.get(entry.key) ?? 0) + 1;
              keyIndices.set(entry.key, occurrence);
              const isDuplicate = count > 1;
              const isLast = occurrence === count;

              let keyLabel = `Key ${entry.key}`;
              let valueLabel = `Value for ${entry.key}`;
              let showLabel = `${shown ? "Hide" : "Show"} ${entry.key}`;
              let removeLabel = `Remove ${entry.key}`;

              if (isDuplicate) {
                const suffix = isLast
                  ? " (last, used by compose)"
                  : ` (occurrence ${occurrence} of ${count})`;
                keyLabel += suffix;
                valueLabel += suffix;
                showLabel += suffix;
                removeLabel += ` (all ${count} occurrences)`;
              }

              return (
                <li
                  // Index-based keys are correct here: .env permits duplicate
                  // keys, so `key={entry.key}` collides when the same variable
                  // is set twice. Position is stable (lines never reorder).
                  // biome-ignore lint/suspicious/noArrayIndexKey: duplicate keys require positional identity
                  key={index}
                  className={`flex flex-wrap items-center gap-2 ${isDuplicate ? "border border-warning rounded-md p-2" : ""}`}
                >
                  <Input
                    aria-label={keyLabel}
                    value={entry.key}
                    readOnly
                    className={isDuplicate ? "border-warning" : ""}
                  />
                  <Input
                    aria-label={valueLabel}
                    type={secret && !shown ? "password" : "text"}
                    value={entry.value}
                    onChange={(e) =>
                      emit(setEntryValue(lines, entry.key, e.target.value))
                    }
                    className={isDuplicate ? "border-warning" : ""}
                  />
                  {secret ? (
                    <IconButton
                      label={showLabel}
                      onClick={() =>
                        setRevealed((r) => ({ ...r, [entry.key]: !shown }))
                      }
                    >
                      {shown ? "🙈" : "👁"}
                    </IconButton>
                  ) : null}
                  <IconButton
                    label={removeLabel}
                    onClick={() => emit(removeEntry(lines, entry.key))}
                  >
                    ✕
                  </IconButton>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Key for the new variable"
              aria-describedby={keyError ? errorId : undefined}
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
            />
            <Button
              disabled={newKey === "" || keyError !== null}
              onClick={() => {
                emit(addEntry(lines, newKey, ""));
                setNewKey("");
              }}
            >
              Add variable
            </Button>
          </div>
          {keyError ? (
            <p role="alert" id={errorId} className="text-danger text-sm">
              {keyError}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
