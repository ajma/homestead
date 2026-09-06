import type { HTMLAttributes, ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
  className = "",
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center py-12 px-4 text-center ${className}`}
      {...rest}
    >
      <h2 className="text-lg font-semibold text-text mb-2">{title}</h2>
      {description && <p className="text-sm text-muted mb-4">{description}</p>}
      {action && <div>{action}</div>}
    </div>
  );
}
