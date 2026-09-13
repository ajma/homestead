import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@web/api/client";
import type { Me } from "@web/auth/useSession";
import { PAGE_MAX_WIDTH } from "@web/lib/density";
import { useEventStream } from "@web/live/useEventStream";
import { NavLink, Outlet } from "react-router-dom";

export function AppLayout({ me }: { me: Me }) {
  useEventStream();
  const queryClient = useQueryClient();
  const isAdmin = me.role === "admin";

  const link = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-2 text-sm rounded-lg ${isActive ? "bg-slate-900 text-white" : "text-slate-600"}`;

  async function signOut() {
    await apiFetch("/api/auth/sign-out", { method: "POST", body: "{}" });
    await queryClient.invalidateQueries({ queryKey: ["me"] });
  }

  return (
    <div className="min-h-dvh">
      {/*
       * The bar itself (background, `border-b`) stays full-bleed — only its content is
       * constrained, to the same `PAGE_MAX_WIDTH` every page (and `EditApp`'s own sticky
       * header) lines up against, so the nav sits directly above the body it belongs to.
       */}
      <header className="border-b border-slate-200">
        <div className={`mx-auto flex items-center gap-2 px-4 py-2 ${PAGE_MAX_WIDTH}`}>
          <span className="mr-auto font-semibold">Homestead</span>
          <NavLink to="/" className={link} end>
            Apps
          </NavLink>
          {isAdmin && (
            <NavLink to="/apps" className={link}>
              Manage
            </NavLink>
          )}
          {isAdmin && (
            <NavLink to="/settings" className={link}>
              Settings
            </NavLink>
          )}
          <button type="button" onClick={signOut} className="px-3 py-2 text-sm text-slate-600">
            Sign out
          </button>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
