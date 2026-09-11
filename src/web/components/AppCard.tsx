import type { LauncherApp } from "@shared/launcher";
import { AppIcon } from "@web/components/AppIcon";
import { StatusChip } from "@web/components/StatusChip";

/**
 * The card is the launch target; the chip inside it is not. Checking whether something
 * is healthy must never risk opening it.
 *
 * A down app stays clickable and is only dimmed. The probe is at least as likely to be
 * broken as the app, and a tile you cannot click when you most want to is worse than a
 * tile that opens something slow.
 */
export function AppCard({
  app,
  onOpenHealth,
}: {
  app: LauncherApp;
  onOpenHealth: (appId: string) => void;
}) {
  const dimmed = app.status === "down" ? "opacity-60" : "";
  const body = (
    <>
      <AppIcon iconRef={app.iconRef} displayName={app.displayName} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-slate-900 dark:text-slate-100">{app.displayName}</p>
        {app.description !== null && (
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">{app.description}</p>
        )}
      </div>
    </>
  );

  const shell =
    "flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900";

  return (
    <div className="flex flex-col gap-1">
      {app.launchUrl === null ? (
        <div className={`${shell} ${dimmed}`}>{body}</div>
      ) : (
        <a
          href={app.launchUrl}
          target="_blank"
          // `noreferrer` matters: the target is a self-hosted app that has no business
          // learning the launcher's URL, which for an exposed deployment is a hostname
          // the user may not want propagated.
          rel="noreferrer noopener"
          className={`${shell} ${dimmed} hover:border-slate-300 dark:hover:border-slate-700`}
        >
          {body}
        </a>
      )}
      <div className="px-1">
        <StatusChip
          status={app.status}
          reason={app.reason}
          since={app.since}
          onOpen={() => onOpenHealth(app.id)}
        />
      </div>
    </div>
  );
}
