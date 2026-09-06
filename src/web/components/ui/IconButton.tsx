import type { ComponentPropsWithRef, ReactNode } from "react";

export function IconButton({
  label,
  children,
  className = "",
  ...rest
}: ComponentPropsWithRef<"button"> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className={`inline-flex items-center justify-center min-h-11 min-w-11 rounded-md text-text hover:bg-raised transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
