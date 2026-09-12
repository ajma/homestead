import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSetupState } from "@web/api/setup";
import { useSession } from "@web/auth/useSession";
import { ErrorBoundary } from "@web/components/ErrorBoundary";
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
import { SetupWizard } from "@web/routes/setup/SetupWizard";
import { type ComponentType, lazy, Suspense, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

// CodeMirror, its schema-driven completions and both lint layers are the largest thing
// in this app's bundle by far (measured: ~580 kB raw, ~183 kB gzip of the ~930 kB total)
// — and an admin-only feature a viewer can never even navigate to. The launcher every
// visitor opens first, and the page the spec requires to render during an outage, has no
// business paying for it. `React.lazy` defers both editor tabs into their own chunk,
// fetched only once an admin actually opens `compose` or `env`.
function loadComposeTab() {
  return import("@web/routes/edit/ComposeTab").then((m) => ({ default: m.ComposeTab }));
}
function loadEnvTab() {
  return import("@web/routes/edit/EnvTab").then((m) => ({ default: m.EnvTab }));
}

/** Shown for the brief window the editor chunk takes to download — a route-level
 * fallback, not a skeleton, matching the plain loading text `ComposeTab`/`EnvTab`
 * themselves show once mounted while their own data is still in flight. */
function LoadingEditor() {
  return <p className="p-4 text-sm text-slate-500 dark:text-slate-400">Loading editor…</p>;
}

/**
 * One lazily-loaded tab, wrapped in its own `ErrorBoundary` rather than sharing one across
 * every admin route. A chunk load failure here (a deploy landing mid-session, the NAS
 * dropping off the network) must not unmount `EditApp`'s tab nav or anything above it —
 * only this route's own content should show the failure, with a way back that doesn't
 * require a full page reload.
 *
 * The loader lives in this component's own state, not a module-level constant, precisely
 * so `onRetry` can hand the boundary a BRAND NEW `React.lazy` component to render next —
 * see `ErrorBoundary`'s own doc comment for why reusing the same one would just replay the
 * same cached rejection.
 */
function LazyTab({ loader }: { loader: () => Promise<{ default: ComponentType }> }) {
  const [Tab, setTab] = useState(() => lazy(loader));
  return (
    <ErrorBoundary onRetry={() => setTab(() => lazy(loader))}>
      <Suspense fallback={<LoadingEditor />}>
        <Tab />
      </Suspense>
    </ErrorBoundary>
  );
}

// Exported (not just module-private) so `App.test.tsx` can `queryClient.clear()` between
// renders of the real `<App>` — the route guard is only meaningful end-to-end, through
// the actual singleton, so the test cannot swap in a fresh `QueryClientProvider` of its
// own the way a component test would.
export const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

function Routed() {
  const { data: me, isPending } = useSession();
  const isViewer = me?.role === "viewer";
  // A viewer can't act on setup — inviting them into the wizard, or stranding them on
  // an error screen when the check itself fails, would both be wrong — and
  // `GET /api/setup/state` is admin-only once an admin exists, so firing it for a
  // viewer only invites a 403 that has nothing to do with what they're allowed to see.
  // Skipping the fetch entirely, rather than fetching and then ignoring a 403, is the
  // difference between "never sees the wizard" and "briefly sees an error instead of
  // one".
  const needsSetupCheck = !isViewer;
  const setup = useSetupState({ enabled: !isPending && needsSetupCheck });

  if (isPending) return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  if (needsSetupCheck && setup.isPending) {
    return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  }
  // The route that decides whether anyone can use the product at all must not strand a
  // visitor on a blank page just because this one check failed.
  if (needsSetupCheck && setup.isError) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="max-w-sm space-y-3 text-center">
          <h1 className="text-lg font-semibold">Homestead is unavailable</h1>
          <p className="text-sm text-slate-500">
            Could not check setup status. Nothing has been lost — try again.
          </p>
          <button
            type="button"
            onClick={() => setup.refetch()}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const setupComplete = !needsSetupCheck || setup.data?.completedAt != null;

  // The two-way guard, above the admin check below on purpose: a machine with no users
  // has no admin to authorise anything, so the wizard has to be reachable
  // unauthenticated for its first step, and only needs a session from the second step
  // on. Incomplete setup pulls every other route to `/setup`; a viewer is the one
  // exception, since they can't complete it and must not be trapped by it either.
  if (!setupComplete) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupWizard />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (!me) return <Login />;

  const isAdmin = me.role === "admin";

  return (
    <Routes>
      {/* Setup is complete (or this is a viewer, for whom it's moot) — re-entering the
          wizard would offer "create the first admin" to a second admin, which is why
          completion is one-way. Written out explicitly rather than left to the
          catch-all below: that generic 404 fallback would currently redirect `/setup`
          to the same place, but it exists for unrelated reasons (a typo'd URL), and
          this rule needs to keep holding even if that one's target ever changes. */}
      <Route path="/setup" element={<Navigate to="/" replace />} />
      <Route element={<AppLayout me={me} />}>
        <Route path="/" element={<Launcher />} />
        <Route path="/apps" element={isAdmin ? <AdminApps /> : <Navigate to="/" replace />} />
        <Route path="/apps/:slug/*" element={isAdmin ? <EditApp /> : <Navigate to="/" replace />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewTab />} />
          <Route path="containers" element={<ContainersTab />} />
          <Route path="logs" element={<LogsTab />} />
          <Route path="probes" element={<ProbesTab />} />
          <Route path="compose" element={<LazyTab loader={loadComposeTab} />} />
          <Route path="env" element={<LazyTab loader={loadEnvTab} />} />
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
