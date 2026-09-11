import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@web/api/client";
import { AppIcon } from "@web/components/AppIcon";
import { useEffect, useState } from "react";

/** One row of `GET /api/icons/search`'s `icons` array — only what this picker renders. */
type IconResult = { slug: string; aliases: string[] };

/**
 * How long to wait after the last keystroke before searching. The endpoint is capped at
 * 50 results and rate-limited at 300/min per IP across the whole API; a fast typist
 * hitting one request per keystroke on a six-letter word would spend a tenth of that
 * budget searching for one icon.
 */
const DEBOUNCE_MS = 250;

/**
 * A search over the 3,238-entry dashboard-icons catalogue, proxied through
 * `GET /api/icons/search` so the browser never talks to the CDN directly (see
 * `AppIcon`'s own comment on why). Built for `OverviewTab`'s icon field, but the
 * `{ value, onChange }` shape has no dependency on `AdminApp` — a plain controlled input
 * over a nullable icon slug.
 *
 * The query is only sent once the field is non-empty. The catalogue is too large to page
 * through usefully, and most edits never touch this control at all, so a default page
 * fetched on mount would be a request paid by every visit for a result almost nobody
 * looks at.
 */
export function IconPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (slug: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const trimmed = debounced.trim();
  const { data, isPending } = useQuery({
    queryKey: ["icons", "search", trimmed],
    enabled: trimmed !== "",
    queryFn: () =>
      apiFetch<{ icons: IconResult[] }>(`/api/icons/search?q=${encodeURIComponent(trimmed)}`),
    staleTime: 60_000,
  });

  const results = trimmed === "" ? [] : (data?.icons ?? []);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <AppIcon iconRef={value} displayName={value ?? "?"} size="sm" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search icons…"
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
        />
        <button
          type="button"
          onClick={() => onChange(null)}
          className="shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
        >
          Use a letter tile
        </button>
      </div>

      {trimmed !== "" && (
        <div className="flex flex-wrap gap-2">
          {isPending && <p className="text-sm text-slate-500">Searching…</p>}
          {!isPending && results.length === 0 && (
            <p className="text-sm text-slate-500">No icons match “{trimmed}”.</p>
          )}
          {results.map((icon) => (
            <button
              key={icon.slug}
              type="button"
              onClick={() => onChange(icon.slug)}
              className="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-800"
            >
              <AppIcon iconRef={icon.slug} displayName={icon.slug} size="sm" />
              {icon.slug}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
