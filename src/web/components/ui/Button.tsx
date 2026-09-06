import type { ComponentPropsWithRef, ReactNode } from "react";
import { Spinner } from "./Spinner.js";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-contrast hover:opacity-90",
  secondary: "bg-raised text-text border border-border hover:bg-surface",
  danger: "bg-danger text-accent-contrast hover:opacity-90",
  ghost: "text-text hover:bg-raised",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  children,
  className = "",
  disabled,
  ...rest
}: ComponentPropsWithRef<"button"> & {
  variant?: Variant;
  size?: "sm" | "md";
  loading?: boolean;
  children: ReactNode;
}) {
  // 44px min target at md — below this, touch accuracy collapses.
  const sizing =
    size === "md" ? "min-h-11 px-4 text-sm" : "min-h-9 px-3 text-sm";
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${VARIANTS[variant]} ${sizing} ${className}`}
      {...rest}
    >
      {loading && <Spinner size={16} />}
      {children}
    </button>
  );
}
