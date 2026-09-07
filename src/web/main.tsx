import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./App.js";
import { createQueryClient } from "./lib/queries.js";
import "./index.css";

/**
 * A **data** router, not `<BrowserRouter>`.
 *
 * `useUnsavedChanges` is built on `useBlocker`, which reads the router object
 * rather than the location and throws outright under a plain `<BrowserRouter>`
 * — so an editor with unsaved work could not be guarded at all. One catch-all
 * route keeps `App.tsx` exactly as it was: its `<Routes>` is a descendant
 * router, which is still blocked because there is only one history underneath.
 *
 * Created at module scope on purpose: a router rebuilt on every render would
 * discard the history — including the entry a blocked navigation is holding.
 */
const router = createBrowserRouter([{ path: "*", element: <App /> }]);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
