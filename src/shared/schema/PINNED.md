# Vendored compose schema

Source: https://github.com/compose-spec/compose-spec
Commit: fee041b381ffd4aad263410980bdce0cdf4beb7d
Vendored: 2026-09-12

Refresh with:

    pnpm exec tsx scripts/vendor-compose-schema.ts <ref>

Then run the suite. `compose-schema-vendored.test.ts` checks the shape the
completion walk depends on, so a breaking upstream restructure fails there rather
than silently emptying the editor's suggestions.
