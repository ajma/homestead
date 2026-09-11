export type ProbeState = {
  lastStatus: "up" | "degraded" | "down" | "starting" | "unknown";
  consecutiveFailures: number;
  statusSince: number | null;
};

export type TransitionInput = {
  state: ProbeState;
  observed: "up" | "degraded" | "down";
  now: number;
  graceUntil: number | null;
  failureThreshold: number;
};

export type TransitionOutput = {
  status: "up" | "degraded" | "down" | "starting" | "unknown";
  consecutiveFailures: number;
  statusSince: number;
  changed: boolean;
};

/**
 * Decides what a single observation does to a probe's recorded state.
 *
 * Asymmetric on purpose: N consecutive failures to fall, one success to recover. The
 * action a failure triggers is a human picking up their phone, so a false alarm costs
 * more than a minute of delayed detection.
 *
 * `statusSince` moves only on a confirmed transition. That is what makes the timeline a
 * record of outages rather than of samples.
 */
export function applyTransition(input: TransitionInput): TransitionOutput {
  const { state, observed, now, graceUntil, failureThreshold } = input;
  const failed = observed !== "up";

  // Count failures even inside the grace window. Suppressing the count as well as the
  // status would mean a stack that never comes back reads healthy for another
  // `failureThreshold` intervals after the window closes.
  const consecutiveFailures = failed ? state.consecutiveFailures + 1 : 0;

  const inGrace = graceUntil !== null && graceUntil > now;

  let status: TransitionOutput["status"];
  if (!failed) {
    status = "up";
  } else if (inGrace) {
    // A restart the user initiated is not an outage.
    status = "starting";
  } else if (consecutiveFailures >= failureThreshold) {
    status = observed;
  } else {
    // Not yet confirmed: hold whatever we were showing. A probe that has never reported
    // anything holds `unknown` rather than claiming `starting` — nothing is starting, we
    // simply have not confirmed a failure yet, and the launcher already renders unknown.
    status = state.lastStatus;
  }

  const changed = status !== state.lastStatus;
  return {
    status,
    consecutiveFailures,
    statusSince: changed || state.statusSince === null ? now : state.statusSince,
    changed,
  };
}
