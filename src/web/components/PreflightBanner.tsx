import type { PreflightResult } from "@shared/preflight.js";

export function PreflightBanner({ checks }: { checks: PreflightResult[] }) {
  const failures = checks.filter((c) => !c.ok);

  if (failures.length === 0) {
    return null;
  }

  return (
    <div
      role="alert"
      className="border-b border-border bg-surface px-3 py-3 sm:px-4"
    >
      <div className="space-y-3">
        {failures.map((check) => {
          const textColor =
            check.severity === "danger" ? "text-danger" : "text-warning";
          const borderColor =
            check.severity === "danger" ? "border-danger" : "border-warning";

          return (
            <div
              key={check.id}
              className={`rounded-md border ${borderColor} bg-raised px-3 py-2`}
            >
              <p className={`font-medium ${textColor}`}>{check.label}</p>
              <p className={`mt-1 text-sm ${textColor}`}>{check.detail}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
