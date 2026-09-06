import type { ComponentPropsWithRef } from "react";

/**
 * The app's one text field.
 *
 * `border border-border`, not `border-border` alone. Tailwind v4's preflight
 * sets `border: 0 solid` on every element, so a colour utility with no width
 * companion emits a valid rule that draws nothing — the sign-in and setup
 * fields were invisible boxes in both themes for the whole of Plan 3, and the
 * conformance gate could not see it because the class *did* resolve. The width
 * belongs next to the colour, always.
 *
 * `min-h-11` for the same 44px minimum `Button`, `IconButton` and the list rows
 * hold themselves to: these are the first controls a new user touches, quite
 * possibly on a phone.
 */
export function Input({
  className = "",
  ...rest
}: ComponentPropsWithRef<"input">) {
  return (
    <input
      className={`min-h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-text transition placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${className}`}
      {...rest}
    />
  );
}
