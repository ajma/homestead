import { useState } from "react";

/**
 * Fixed palette rather than a generated HSL value: every colour here has a checked
 * contrast ratio against white text in both themes, which a hash-to-hue does not.
 */
const TILE_COLOURS = [
  "bg-sky-600",
  "bg-emerald-600",
  "bg-violet-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-teal-600",
];

function colourFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return TILE_COLOURS[hash % TILE_COLOURS.length] as string;
}

/**
 * `iconRef` is a dashboard-icons slug. The `src` always points at Homestead's own
 * proxy — hotlinking would tell a public CDN exactly which self-hosted services run
 * here, from every viewer's network, which is an odd disclosure for a tool premised on
 * not handing infrastructure to third parties.
 */
export function AppIcon({
  iconRef,
  displayName,
  size = "lg",
}: {
  iconRef: string | null;
  displayName: string;
  size?: "sm" | "lg";
}) {
  const [failed, setFailed] = useState(false);
  const box = size === "lg" ? "h-12 w-12 text-lg" : "h-6 w-6 text-xs";

  if (iconRef === null || failed) {
    const letter = displayName.trim().charAt(0).toUpperCase() || "?";
    return (
      <div
        className={`${box} ${colourFor(displayName)} flex shrink-0 items-center justify-center rounded-xl font-semibold text-white`}
        aria-hidden="true"
      >
        {letter}
      </div>
    );
  }

  return (
    <img
      // The server picks the theme variant; `prefers-color-scheme` is not readable from
      // a URL, so the variant query is set by the browser's media query below.
      src={`/api/icons/${iconRef}.svg`}
      alt={displayName}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`${box} shrink-0 rounded-xl object-contain`}
    />
  );
}
