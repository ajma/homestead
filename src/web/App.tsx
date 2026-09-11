import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "@web/auth/useSession";
import { AdminApps } from "@web/routes/AdminApps";
import { AppLayout } from "@web/routes/AppLayout";
import { EditApp } from "@web/routes/EditApp";
import { ContainersTab } from "@web/routes/edit/ContainersTab";
import { LogsTab } from "@web/routes/edit/LogsTab";
import { OverviewTab } from "@web/routes/edit/OverviewTab";
import { ProbesTab } from "@web/routes/edit/ProbesPanel";
import { Launcher } from "@web/routes/Launcher";
import { Login } from "@web/routes/Login";
import { Placeholder } from "@web/routes/Placeholder";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

// Exported (not just module-private) so `App.test.tsx` can `queryClient.clear()` between
// renders of the real `<App>` — the route guard is only meaningful end-to-end, through
// the actual singleton, so the test cannot swap in a fresh `QueryClientProvider` of its
// own the way a component test would.
export const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

function Routed() {
  const { data: me, isPending } = useSession();

  if (isPending) return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  if (!me) return <Login />;

  const isAdmin = me.role === "admin";

  return (
    <Routes>
      <Route element={<AppLayout me={me} />}>
        <Route path="/" element={<Launcher />} />
        <Route path="/apps" element={isAdmin ? <AdminApps /> : <Navigate to="/" replace />} />
        <Route path="/apps/:slug/*" element={isAdmin ? <EditApp /> : <Navigate to="/" replace />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewTab />} />
          <Route path="containers" element={<ContainersTab />} />
          <Route path="logs" element={<LogsTab />} />
          <Route path="probes" element={<ProbesTab />} />
        </Route>
        <Route
          path="/settings/*"
          element={isAdmin ? <Placeholder title="Settings" /> : <Navigate to="/" replace />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routed />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
