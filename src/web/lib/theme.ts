export type ColorScheme = "light" | "dark" | "system";

const KEY = "homestead.color-scheme";

export function resolveScheme(
  stored: string | null,
  prefersDark: boolean,
): "light" | "dark" {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

export function readStoredScheme(): ColorScheme {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function storeScheme(scheme: ColorScheme): void {
  if (scheme === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, scheme);
}

export function applyScheme(scheme: "light" | "dark"): void {
  document.documentElement.dataset.theme = scheme;
}
