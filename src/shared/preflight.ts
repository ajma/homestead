// Browser-safe types only — no node: imports, no runtime footprint.
// The web app imports from @shared/*, which must stay side-effect-free.

export type Severity = "warning" | "danger";

export type PreflightResult = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  severity: Severity;
};
