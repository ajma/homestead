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
export type RunningContainer = {
  id: string;
  image: string;
  /** Compose project, or "" for a container started outside compose. */
  project: string;
};

export async function listContainers(
  run: Runner = runDocker,
): Promise<RunningContainer[]> {
  let stdout: string;
  try {
    const result = await run([
      "ps",
      "--format",
      // The compose project distinguishes a cloudflared Homestead deployed
      // from one someone else started, which is the deployed/adopted split.
      '{{.ID}}\t{{.Image}}\t{{.Label "com.docker.compose.project"}}',
    ]);
    if (result.code !== 0) return [];
    stdout = result.stdout;
  } catch {
    return [];
  }

  return stdout
    .split("\n")
    .map((line) => {
      const [id, image, project] = line.split("\t");
      return {
        id: id?.trim() ?? "",
        image: image?.trim() ?? "",
        project: project?.trim() ?? "",
      };
    })
    .filter((c) => c.id !== "" && c.image !== "");
}
