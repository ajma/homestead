import type { HTMLAttributes, ReactNode } from "react";

type Tone = "neutral" | "success" | "danger" | "warning" | "accent";

const TONES: Record<Tone, string> = {
  neutral: "bg-raised text-muted",
  success: "bg-success/10 text-success",
  danger: "bg-danger/10 text-danger",
  warning: "bg-warning/10 text-warning",
  accent: "bg-accent/10 text-accent",
};

export function Badge({
  tone = "neutral",
  children,
  className = "",
  ...rest
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded ${TONES[tone]} ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}
