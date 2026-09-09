/**
 * The blank scaffold from spec §6.1.
 *
 * No `x-homestead` block. It existed to mark provenance — its absence meant
 * Homestead had adopted the directory rather than created it, which made
 * deletion ask for the slug twice instead of once. That distinction is gone,
 * and nothing else ever read the block: the `displayName`, `description` and
 * `icon` it once carried moved to the `project_identity` table, and the
 * remaining keys were parsed into a value with no consumer.
 *
 * Compose files already written with the block keep it. `x-` keys are
 * extension fields Compose ignores, so it costs nothing where it sits, and
 * rewriting every user's compose file to strip a harmless key would be worse
 * than leaving it.
 *
 * The comment sits *above* an explicit empty map on purpose: per §9.3,
 * `services:` followed only by comments parses as null and `docker compose
 * config` rejects it with "services must be a mapping".
 */
export function blankScaffold(slug: string): string {
  return `name: ${slug}

# Add services below, for example:
#   web:
#     image: nginx
#     ports: ["127.0.0.1:8080:80"]
services: {}
`;
}
