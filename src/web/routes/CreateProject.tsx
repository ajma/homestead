import { isReservedSlug, isValidSlug } from "@shared/projects.js";
import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Input, SegmentedControl } from "../components/ui/index.js";
import { ApiError } from "../lib/api.js";
import { useCreateProject } from "../lib/queries.js";

/**
 * The same rule `isValidSlug` enforces, said in words a person can act on.
 *
 * Checked on the client *before* the request so a typo costs no round trip and
 * no half-created directory — the server enforces it too, from the same shared
 * function, so the two can never drift into disagreeing.
 */
const SLUG_HINT =
  "Use letters, digits, dots, dashes and underscores. It must not start with a dot.";

/**
 * A reserved name is not a malformed one, and saying "invalid" would be a lie
 * the user cannot act on. The reason is concrete because the consequence is:
 * the project would be created and then permanently unreachable.
 */
const RESERVED_HINT = (slug: string) =>
  `"${slug}" is reserved for a Homestead page, so a project with that name could not be opened afterwards. Please pick another.`;

/**
 * "Paste", not "Paste a compose file". The longer label made the radio and the
 * textarea below it share an accessible name containing "compose file", so
 * `getByLabelText(/compose file/i)` matched two elements — a real ambiguity a
 * screen reader user would hear as two identically named controls, not a test
 * artefact. The "Starting point" heading above supplies the missing noun.
 */
const SOURCES = [
  { id: "blank", label: "Blank" },
  { id: "paste", label: "Paste" },
];

export function CreateProject() {
  const navigate = useNavigate();
  const create = useCreateProject();
  const [slug, setSlug] = useState("");
  const [source, setSource] = useState<"blank" | "paste">("blank");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const hintId = useId();
  const errorId = useId();

  async function submit() {
    // Said separately from SLUG_HINT: "new" breaks none of the character
    // rules, so the generic hint would send the user hunting for a typo that
    // is not there.
    if (isReservedSlug(slug)) {
      setError(RESERVED_HINT(slug));
      return;
    }
    if (!isValidSlug(slug)) {
      setError(SLUG_HINT);
      return;
    }
    setError(null);
    try {
      const res = await create.mutateAsync({
        slug,
        source,
        ...(source === "paste" ? { content } : {}),
      });
      // Navigate even when res.valid === false: the file is stored, and the
      // detail page surfaces parseError so the user can fix it in the editor.
      // Refusing the paste, or landing them anywhere else, would make storing
      // it pointless — it is content they have nowhere else to put.
      navigate(`/projects/${res.slug}/edit`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "project_exists") {
        setError(`A project named "${slug}" already exists.`);
        return;
      }
      setError("Could not create the project. Please try again.");
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-8">
      <h1 className="font-semibold text-2xl text-text">New project</h1>

      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-muted text-sm">
          Name
        </label>
        <Input
          id={nameId}
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          aria-invalid={error ? true : undefined}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        {/* Rename is deferred (§8), so say so rather than letting someone
            discover it after they have built a stack around the name. */}
        <p id={hintId} className="text-muted text-sm">
          This becomes the directory on disk and cannot be changed later.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-muted text-sm">Starting point</span>
        <div>
          <SegmentedControl
            items={SOURCES}
            value={source}
            onChange={(v) => setSource(v === "paste" ? "paste" : "blank")}
          />
        </div>
      </div>

      {source === "paste" ? (
        <textarea
          aria-label="Compose file"
          className="min-h-64 rounded-md border border-border bg-surface p-2 font-mono text-sm text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
        />
      ) : null}

      {error ? (
        <p id={errorId} role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={submit}
          loading={create.isPending}
          disabled={create.isPending}
        >
          Create project
        </Button>
        <Button onClick={() => navigate("/projects")}>Cancel</Button>
      </div>
    </main>
  );
}
