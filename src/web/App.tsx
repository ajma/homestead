import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "@web/auth/useSession";
import { AppLayout } from "@web/routes/AppLayout";
import { Launcher } from "@web/routes/Launcher";
import { Login } from "@web/routes/Login";
import { Placeholder } from "@web/routes/Placeholder";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

const queryClient = new QueryClient({
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
        <Route
          path="/apps/*"
          element={isAdmin ? <Placeholder title="Manage apps" /> : <Navigate to="/" replace />}
        />
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
