import { type Runner, runDocker } from "./run.js";

/**
 * Every container on the host, not just those in a Homestead project.
 *
 * `composePs` cannot answer this: it is scoped to one compose project, and the
 * question adoption asks — "is a cloudflared already running here?" — has to
 * include one someone started by hand, outside `$HOMESTEAD_PROJECTS`.
 *
 * Docker being unreachable yields an empty list rather than an error. Setup
 * must still finish on a box with no socket; the startup checks already say so
 * plainly, and failing here would only repeat that in a worse place.
 */
export async function listContainers(
  run: Runner = runDocker,
): Promise<{ id: string; image: string }[]> {
  let stdout: string;
  try {
    const result = await run(["ps", "--format", "{{.ID}}\t{{.Image}}"]);
    if (result.code !== 0) return [];
    stdout = result.stdout;
  } catch {
    return [];
  }

  return stdout
    .split("\n")
    .map((line) => {
      const [id, image] = line.split("\t");
      return { id: id?.trim() ?? "", image: image?.trim() ?? "" };
    })
    .filter((c) => c.id !== "" && c.image !== "");
}
