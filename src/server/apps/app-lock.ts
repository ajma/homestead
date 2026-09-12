/**
 * The one mutex per app, shared by every runner that mutates an app's containers.
 *
 * `tryAcquire` is synchronous and must stay that way. `JobRunner.start` (`job-runner.ts`)
 * has a documented synchronous window — measured, not hypothesised: with an async gate,
 * two `start` calls issued in the same tick both passed the check and both spawned
 * `docker compose up` on the same stack, because each read the map before the other's
 * write landed. Keeping this whole class synchronous means the same guarantee costs
 * nothing extra to preserve at every call site: acquire, decide, and (if granted) record
 * the holder all happen before control returns to the event loop.
 */
export class AppBusyError extends Error {
  constructor(
    readonly appId: string,
    readonly holder: string,
  ) {
    super(`App ${appId} is busy: ${holder}`);
    this.name = "AppBusyError";
  }
}

export class AppLock {
  private readonly holders = new Map<string, string>();

  /** True and records `holder` if `appId` was free; false, unchanged, if it was not. */
  tryAcquire(appId: string, holder: string): boolean {
    if (this.holders.has(appId)) return false;
    this.holders.set(appId, holder);
    return true;
  }

  /** A no-op, not a throw, for an app that was never held — releasing is not paired
   * one-to-one with a successful acquire at every call site (a failed acquire never
   * needs to release), so this must tolerate being called on an app that isn't held. */
  release(appId: string): void {
    this.holders.delete(appId);
  }

  /** The holder's description if `appId` is currently locked, otherwise `undefined`. */
  heldBy(appId: string): string | undefined {
    return this.holders.get(appId);
  }
}
