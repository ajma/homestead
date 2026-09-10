import { currentProjectName, statusFor } from "../apps/status-for.js";
import type { ProbeContext, ProbeResult, ProbeRow, ProbeRunner } from "./types.js";

export const dockerRunner: ProbeRunner = {
  kind: "docker",

  async run(_probe: ProbeRow, ctx: ProbeContext): Promise<ProbeResult> {
    if (ctx.containers === null) {
      // The Engine API call failed for the whole tick. Not the app's fault.
      return {
        status: "down",
        faultClass: "network",
        detail: { summary: "Docker is not reachable" },
      };
    }

    const project = await currentProjectName(ctx.deps, ctx.app);
    const mine = ctx.containers.filter((container) => container.project === project);
    const rolled = await statusFor(ctx.deps, ctx.app, mine);

    if (rolled.status === "unknown") {
      // `statusFor` returns unknown only when the compose file could not be read or
      // resolved — a configuration problem, not a dead container. `adminDetail` holds raw
      // stderr and must not travel into a payload the viewer's status line can reach.
      return {
        status: "down",
        faultClass: "config",
        detail: { summary: rolled.detail ?? "compose configuration is invalid" },
      };
    }

    // `starting` is not one of the three verdicts a runner may return — the grace window
    // in `applyTransition` is what turns a confirmed failure into `starting`, and it needs
    // to see the raw observation to do that.
    const status = rolled.status === "starting" ? "degraded" : rolled.status;
    return {
      status,
      ...(status === "up" ? {} : { faultClass: "app" as const }),
      detail: { summary: rolled.detail ?? "" },
    };
  },
};
