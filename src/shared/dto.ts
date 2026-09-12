import type { AppStatus } from "./types.js";

/**
 * What a viewer sees. Deliberately a distinct type rather than a subset of the admin
 * shape: a field added to the app row cannot reach this object unless someone edits
 * this declaration, which is a reviewable act.
 */
export type ViewerApp = {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  iconRef: string | null;
  category: string | null;
  launchUrl: string | null;
  status: AppStatus;
  statusDetail: string | null;
};

/** What an admin sees: operational identity plus everything a viewer sees. */
export type AdminApp = ViewerApp & {
  hostId: string;
  directory: string;
  composeFile: string;
  projectName: string;
  lastComposeHash: string | null;
  systemKind: "self" | "cloudflared" | null;
  showOnLauncher: boolean;
  sortOrder: number;
  graceUntil: number | null;
  adoptedAt: number;
  archivedAt: number | null;
  lastDeployAt: number | null;
  runningJobId: string | null;
};
