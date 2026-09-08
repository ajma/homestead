import { useEffect, useId, useState } from "react";
import {
  type ProjectIdentity,
  useIconSearch,
  useSaveIdentity,
} from "../lib/queries.js";
import { Button, Dialog, Input } from "./ui/index.js";

/**
 * Sets how a project is presented: a readable name, what it is for, an icon.
 *
 * Stored in SQLite rather than the compose file — see the identity design spec
 * §2. Writing `x-homestead` here would flip the provenance marker the delete
 * dialog reads, so naming a project would make it easier to delete.
 */
export function ProjectIdentityDialog({
  open,
  onClose,
  slug,
  identity,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  identity: ProjectIdentity | null;
}) {
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [iconSlug, setIconSlug] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [query, setQuery] = useState("");

  const nameId = useId();
  const descId = useId();
  const iconId = useId();
  const urlId = useId();

  const save = useSaveIdentity(slug);
  const found = useIconSearch(query);

  useEffect(() => {
    if (!open) return;
    setDisplayName(identity?.displayName ?? "");
    setDescription(identity?.description ?? "");
    setIconSlug(identity?.iconSlug ?? "");
    setIconUrl(identity?.iconUrl ?? "");
    setQuery("");
  }, [open, identity]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      // null, not undefined, for an emptied field: clearing a description is a
      // real edit, and undefined would leave the old text in place and look
      // like the save silently failed.
      await save.mutateAsync({
        displayName: displayName.trim() || null,
        description: description.trim() || null,
        iconSlug: iconSlug.trim() || null,
        iconUrl: iconUrl.trim() || null,
      });
      onClose();
    } catch {
      // Rendered from save.error below.
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Edit ${slug}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor={nameId} className="mb-1 block font-medium text-sm">
            Display name
          </label>
          <Input
            id={nameId}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={slug}
          />
          <p className="mt-1 text-muted text-xs">
            Shown instead of the folder name. The slug <code>{slug}</code> stays
            as it is — it is what Compose uses and what you type to delete the
            project.
          </p>
        </div>

        <div>
          <label htmlFor={descId} className="mb-1 block font-medium text-sm">
            Description
          </label>
          <textarea
            id={descId}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What this project is for"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text"
          />
        </div>

        <div>
          <label htmlFor={iconId} className="mb-1 block font-medium text-sm">
            Icon
          </label>
          <Input
            id={iconId}
            value={iconSlug || query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIconSlug("");
            }}
            placeholder="Search icons…"
          />
          <div className="mt-1 flex flex-wrap gap-1">
            {/* Offered before anything is typed: the project slug usually is
                the icon name. Only an exact match — a near miss looks
                deliberate, so nobody goes looking for why it is wrong. */}
            {query === "" && iconSlug === "" && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setIconSlug(slug)}
              >
                Use {slug}
              </Button>
            )}
            {found.data?.map((name) => (
              <Button
                key={name}
                type="button"
                variant="ghost"
                onClick={() => {
                  setIconSlug(name);
                  setQuery("");
                }}
              >
                {name}
              </Button>
            ))}
          </div>
          {iconSlug && (
            <p className="mt-1 text-muted text-xs">Using {iconSlug}</p>
          )}
        </div>

        <div>
          <label htmlFor={urlId} className="mb-1 block font-medium text-sm">
            Icon URL
          </label>
          <Input
            id={urlId}
            value={iconUrl}
            onChange={(e) => setIconUrl(e.target.value)}
            placeholder="https://example.com/icon.png"
          />
          <p className="mt-1 text-muted text-xs">
            For anything the icon set does not have. Also the fallback on a box
            with no outbound internet, where the search finds nothing.
          </p>
        </div>

        {save.error && (
          <div role="alert" className="text-danger text-sm">
            {save.error instanceof Error
              ? save.error.message
              : "Could not save"}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
