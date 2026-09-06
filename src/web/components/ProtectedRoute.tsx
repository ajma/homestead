import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useSession } from "../lib/auth-client.js";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { data, isPending } = useSession();
  if (isPending) return <div className="p-8 text-slate-500">Loading…</div>;
  if (!data) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
