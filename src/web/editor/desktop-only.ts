/** Below this, a completion popup covers the line you are editing. */
const MIN_WIDTH = 768;

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
