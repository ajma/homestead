/**
 * Below this, a completion popup covers the line you are editing. Exported (not just a
 * local constant) so `ConfigTab`'s side-by-side-vs-stacked layout can cite the same
 * number in its own doc comment rather than a second, independently-chosen breakpoint —
 * see that file for why "small screen" needs exactly one definition in this codebase,
 * not two that happen to agree today and could quietly drift apart later.
 */
export const MIN_WIDTH = 768;

export function completionsEnabled(win: Pick<Window, "matchMedia" | "innerWidth">): boolean {
  try {
    if (typeof win.matchMedia !== "function") return false;
    if (!win.matchMedia("(pointer: fine)").matches) return false;
    return win.innerWidth >= MIN_WIDTH;
  } catch {
    // An environment that cannot answer is not one to show a popup in.
    return false;
  }
}
