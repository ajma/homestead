import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";

const NOT_DEFINED = "not defined in .env";

/**
 * A stable factory, shaped like schema-completion.ts's `schemaCompletion`: call it
 * once and pass the resulting `CompletionSource` into `YamlEditor`'s
 * `extraExtensions` array, which the caller must memoise — see that file's doc
 * comment for why identity, not content, is what matters there.
 *
 * `keys` is a function, not an array, so the caller can supply the stack's `.env`
 * key names lazily and swap them out later (Task 10 feeds this from the masked
 * `.env` endpoint) without this source needing to be rebuilt. It is called fresh on
 * every completion request rather than once at construction time, precisely so a
 * `.env` edited in another tab or reloaded after a save is reflected the next time
 * `${` is typed. `keys()` must return names only, never values — completing a
 * variable name needs the key, not the secret, so this never reaches for the reveal
 * endpoint.
 *
 * Triggers on `${`, matching compose's own interpolation syntax, and completes only
 * the part after it — `from` is the position right after the `${`, not the `${`
 * itself, so accepting a completion doesn't touch what the user already typed to
 * open it.
 *
 * A typed name that has fully diverged from every defined key (no defined key even
 * starts with it) is still offered back as its own option, flagged with a `detail`
 * of "not defined in .env" — one of the two things the spec says only the server's
 * `docker compose config` resolution can catch (the other being an undefined
 * `depends_on` target), surfaced here for free instead of waiting on a debounced
 * round trip. A name that is still a valid prefix of some real key (`DB_` while
 * `DB_HOST` exists) is left unflagged, since it isn't wrong yet — only typed so far.
 */
export function envCompletion(keys: () => string[]): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\$\{[\w.-]*/);
    if (!match) return null;

    const typed = match.text.slice(2);
    const from = match.from + 2;
    const defined = keys();

    const options: { label: string; detail?: string }[] = defined.map((label) => ({ label }));

    const isPrefixOfReal = defined.some((key) => key.startsWith(typed));
    if (typed !== "" && !isPrefixOfReal) {
      options.push({ label: typed, detail: NOT_DEFINED });
    }

    return { from, options };
  };
}
