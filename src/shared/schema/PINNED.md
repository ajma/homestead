# Vendored compose schema

Source: https://github.com/compose-spec/compose-spec
Commit: fee041b381ffd4aad263410980bdce0cdf4beb7d
Vendored: 2026-09-12

Refresh with:

    pnpm exec tsx scripts/vendor-compose-schema.ts <ref>

Then run the suite. `compose-schema-vendored.test.ts` checks the shape the
completion walk depends on, so a breaking upstream restructure fails there rather
than silently emptying the editor's suggestions.

## Checking for drift

There is no CI in this repo, so nothing checks this automatically — it's a manual
gate, same shape as `scripts/verify-mount-preflight.sh`. Run it by hand, periodically
or before a release:

    pnpm run check:schema-drift

It reports the pinned commit above, the current commit on compose-spec's default
branch, whether they differ, and — if they do — which top-level service keys
(`$defs.service.properties` in the schema's own terms — `image`, `ports`,
`depends_on`, and so on) are new upstream. That's the actionable part: a schema
commit that only touches formatting or descriptions isn't worth a refresh; one that
adds real service keys is.

If it reports drift, do not refresh the pin as part of resolving that check — see
this script's own doc comment. Refreshing changes what the editor accepts as a valid
key, which deserves its own review, not a side effect of running a check script.

If the pin is left to drift anyway, the failure is silent and in the worst possible
direction: a key compose adds upstream reads as unknown here and draws a warning on
an otherwise-correct compose.yaml. A gutter that cries wolf on correct files is one
people learn to stop reading.
