import { ConfirmDialog } from "@web/components/ConfirmDialog";
import { useUnsavedChanges } from "@web/lib/use-unsaved-changes";
import { useWideEditLayout } from "@web/routes/EditApp";
import { ComposeTab } from "@web/routes/edit/ComposeTab";
import { EnvTab } from "@web/routes/edit/EnvTab";
import { useCallback, useState } from "react";

/**
 * The edit page's Config tab: `ComposeTab` and `EnvTab`, composed rather than merged.
 * Both are the product of a whole phase of review — a masked table, per-key reveal, a
 * raw mode and a 409 hash guard in `EnvTab`; CodeMirror, schema completions and a
 * debounced server validate in `ComposeTab` — and both carry defects-fixed-once that are
 * easy to reintroduce by copying their JSX into a shared body. So this component renders
 * them, unmodified, side by side, and owns exactly one new concern neither of them can
 * own itself: a single unsaved-changes blocker for the pair. See `useUnsavedChanges`'s own
 * doc comment for the measured reason two of them cannot coexist.
 *
 * Stacked below 768px, side by side at and above it — the same "small screen" boundary
 * `desktop-only.ts`'s exported `MIN_WIDTH` already draws for completions, not a second
 * one invented for this layout (Tailwind's own class names can't literally import that
 * constant, which is why it lives here as a comment instead of a value — but it is the
 * same number, on purpose, not a coincidence). Done with a plain Tailwind `md:` breakpoint
 * (Tailwind's default `md` is also 768px) rather than a JS `matchMedia` check:
 * `EditApp.tsx`'s own right-rail layout makes the same call for the same reason — "no JS
 * media query, which would re-render on every resize and could disagree with CSS right at
 * the breakpoint" — and a `<div>` either editor sits in is not a place a JS-computed
 * layout is worth that risk for. Tests assert the class list, not measured geometry: jsdom
 * has no layout engine to measure against, but the Tailwind classes below are literal,
 * deterministic strings a test can (and does) read directly.
 *
 * Also the one tab that opts out of `EditApp`'s capped, centred content column
 * (`PAGE_MAX_WIDTH` in `density.ts` — the same cap every other screen in the app shares)
 * via `useWideEditLayout` — two side-by-side editors are the one case on this page dense
 * enough to want the full row rather than a
 * ~1024px column plus the rail.
 */
export function ConfigTab() {
  useWideEditLayout();
  const [composeDirty, setComposeDirty] = useState(false);
  const [envDirty, setEnvDirty] = useState(false);
  // Stable identities: `useUnsavedChanges`'s own reporting effect depends on the callback
  // it was given, and a fresh closure every render would otherwise refire that effect
  // every render too, for no reason — see that hook's doc comment on `onDirtyChangeRef`.
  const handleComposeDirty = useCallback((dirty: boolean) => setComposeDirty(dirty), []);
  const handleEnvDirty = useCallback((dirty: boolean) => setEnvDirty(dirty), []);

  // The one blocker for the pair, hoisted here specifically so it is the ONLY caller in
  // this tree that ever calls `useBlocker` with a truthy `shouldBlock` — both children
  // below report into this instead of blocking on their own.
  const { blocked, proceed, cancel } = useUnsavedChanges(composeDirty || envDirty);

  return (
    <div className="flex flex-col gap-4 md:flex-row">
      {blocked && (
        <ConfirmDialog
          title="Leave without saving?"
          message="compose.yaml and/or .env have unsaved changes. Leaving this tab now discards them — there is no way to get them back afterwards."
          confirmLabel="Discard changes and leave"
          destructive
          onConfirm={proceed}
          onClose={cancel}
        />
      )}
      <div className="min-w-0 flex-1" data-testid="config-compose-pane">
        <ComposeTab onDirtyChange={handleComposeDirty} />
      </div>
      <div className="min-w-0 flex-1" data-testid="config-env-pane">
        <EnvTab onDirtyChange={handleEnvDirty} />
      </div>
    </div>
  );
}
