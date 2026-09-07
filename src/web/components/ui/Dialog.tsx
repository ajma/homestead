import { type ReactNode, useEffect, useId, useRef } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  title,
  describedBy,
  role = "dialog",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  describedBy?: string;
  role?: "dialog" | "alertdialog";
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    return () => {
      // Restoring focus on close is what keeps keyboard context; without it
      // focus falls to <body> and the user loses their place entirely.
      restoreTo.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const candidates = [
        ...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ];
      // Filter to visible elements: querySelectorAll returns elements inside
      // display:none subtrees, and browsers refuse to focus them. offsetParent
      // is null for hidden elements (and also for position:fixed), so check
      // computed style. Note: this cannot be proven in jsdom, which lacks layout.
      const items = candidates.filter((el) => {
        const style = window.getComputedStyle(el);
        // Explicitly filter out hidden elements. offsetParent would be cleaner
        // but is null in jsdom even for visible elements.
        return style.display !== "none" && style.visibility !== "hidden";
      });
      if (items.length === 0) {
        // No focusables (text-only dialog, or all disabled while a request is
        // in flight): Tab does nothing, keeping focus on the panel.
        e.preventDefault();
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // On the document, not the panel: Escape must work even when focus has
    // drifted outside, which is how Plan 3's inline confirmation lost it.
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  // Known limitation: the background is not inert, so a screen reader can still
  // navigate to it. A correct fix needs a portal so the dialog is not itself
  // inerted. Deferred to plan-level review; pointer risk is theoretical since
  // the overlay intercepts real clicks.
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-overlay p-4 sm:items-center">
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-modal is valid on dialog and alertdialog roles */}
      <div
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        ref={panel}
        tabIndex={-1}
        className="w-full max-w-md rounded-lg border border-border bg-raised p-4 shadow-lg"
      >
        <h2 id={titleId} className="mb-3 font-semibold text-lg text-text">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
