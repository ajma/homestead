export type ColorScheme = "light" | "dark" | "system";

const KEY = "homestead.color-scheme";

export function resolveScheme(
  stored: string | null,
  prefersDark: boolean,
): "light" | "dark" {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

/**
 * A browser with site data blocked throws `SecurityError` on the *access* to
 * `window.localStorage`, not on the call. `index.html`'s pre-paint script has
 * always wrapped its read for exactly this reason; this module did not, and
 * `ThemeToggle` calls it from a mount effect inside the shell — so the throw
 * propagated out of an effect and React 19 unmounted the tree, blanking every
 * authenticated page. Losing the stored preference is a small cost; losing the
 * app is not.
 */
export function readStoredScheme(): ColorScheme {
  let v: string | null = null;
  try {
    v = localStorage.getItem(KEY);
  } catch {
    return "system";
  }
  return v === "light" || v === "dark" ? v : "system";
}

/** Same guard: the choice simply will not survive a reload. */
export function storeScheme(scheme: ColorScheme): void {
  try {
    if (scheme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, scheme);
  } catch {
    // Nothing to do and nothing worth saying: the scheme is applied either way.
  }
}

export function applyScheme(scheme: "light" | "dark"): void {
  document.documentElement.dataset.theme = scheme;
}
