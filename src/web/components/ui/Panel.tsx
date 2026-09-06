import type { HTMLAttributes, ReactNode } from "react";

export function Panel({
  title,
  actions,
  children,
  className = "",
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`bg-surface border border-border rounded-lg ${className}`}
      {...rest}
    >
      {title && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-base font-semibold text-text">{title}</h2>
          {actions && <div>{actions}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}
