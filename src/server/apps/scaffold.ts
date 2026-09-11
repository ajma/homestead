/**
 * The starter compose file for an app created from scratch.
 *
 * Deliberately minimal. The spec asks for "a scaffolded compose", not a template
 * gallery, and a library of stack templates is a product decision nobody has made.
 * What matters is that `docker compose config` accepts it: the user has no editor until
 * Phase 1F, so a scaffold that fails validation leaves them with an app they cannot fix
 * from inside Homestead.
 */
/** Longer than this and the comment is doing something other than naming the app. */
const MAX_COMMENT_LENGTH = 100;

/**
 * Reduces a display name to something safe inside a single `#` YAML comment line.
 *
 * The name is interpolated raw into a comment, and a newline ends that comment early —
 * measured: `displayName = 'Jellyfin\nservices:\n  injected:\n    image: evil'` produces
 * a SECOND top-level `services:` key that `docker compose config` happily accepts. Taking
 * only the first line closes that. Any other control character (a lone `\r`, a tab) is
 * stripped too, on the same reasoning as the newline: nothing about a comment needs them,
 * and the cap keeps a pathological name from producing a wall of comment rather than
 * guarding anything structural.
 */
function sanitiseForComment(displayName: string): string {
  const firstLine = displayName.split(/\r\n|\r|\n/)[0] ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately stripping them
  const printable = firstLine.replace(/[\x00-\x1f\x7f]/g, "");
  return printable.slice(0, MAX_COMMENT_LENGTH);
}

export function scaffoldCompose(displayName: string): string {
  // Never interpolate the raw name into a key. `My App: v2` would produce a YAML parse
  // error at creation time, on a file the user cannot yet edit.
  const service =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app";

  const comment = sanitiseForComment(displayName);

  return `# ${comment}
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
