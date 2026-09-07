import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell.js";
import { ProtectedRoute } from "./components/ProtectedRoute.js";
import { CreateProject } from "./routes/CreateProject.js";
import { Dashboard } from "./routes/Dashboard.js";
import { DeviceDetail } from "./routes/DeviceDetail.js";
import { Devices } from "./routes/Devices.js";
import { Login } from "./routes/Login.js";
import { NotFound } from "./routes/NotFound.js";
import { projectDetailRoute } from "./routes/ProjectDetail.js";
import { ProjectList } from "./routes/ProjectList.js";
import { Setup } from "./routes/Setup.js";

export function App() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["status"],
    queryFn: async () =>
      (await fetch("/api/status")).json() as Promise<{ initialised: boolean }>,
  });

  if (isPending) return <div className="p-8 text-muted">Loading…</div>;
  if (isError)
    return (
      <div className="p-8">
        <h1 className="text-xl font-semibold text-danger">
          Server Unreachable
        </h1>
        <p className="mt-2 text-muted">
          Cannot connect to the Homestead server. Check that the server is
          running and try refreshing the page.
        </p>
      </div>
    );
  if (!data?.initialised) {
    return (
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/setup" element={<Navigate to="/login" replace />} />
      <Route
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/projects" element={<ProjectList />} />
        {/* Ranked above `/projects/:slug` by the router itself — a static
            segment always beats a dynamic one — so the position here is for
            readers, not for matching. "new" is in `RESERVED_SLUGS`, which is
            what stops the form creating a project this route would shadow;
            any static child added beside it needs the same entry. */}
        <Route path="/projects/new" element={<CreateProject />} />
        {projectDetailRoute}
        <Route path="/devices" element={<Devices />} />
        <Route path="/devices/:id" element={<DeviceDetail />} />
        {/* Nested, so an unknown path is still behind ProtectedRoute and still
            renders inside the shell — a mistyped URL keeps its navigation. */}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
