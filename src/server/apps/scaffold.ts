/**
 * The starter compose file for an app created from scratch.
 *
 * Deliberately minimal. The spec asks for "a scaffolded compose", not a template
 * gallery, and a library of stack templates is a product decision nobody has made.
 * What matters is that `docker compose config` accepts it: the user has no editor until
 * Phase 1F, so a scaffold that fails validation leaves them with an app they cannot fix
 * from inside Homestead.
 */
export function scaffoldCompose(displayName: string): string {
  // Never interpolate the raw name into a key. `My App: v2` would produce a YAML parse
  // error at creation time, on a file the user cannot yet edit.
  const service =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app";

  return `# ${displayName}
#
# Created by Homestead. Replace the image and ports below, then deploy.
services:
  ${service}:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "8080:80"
`;
}
