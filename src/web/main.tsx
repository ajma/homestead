import { App } from "@web/App";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@web/index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
