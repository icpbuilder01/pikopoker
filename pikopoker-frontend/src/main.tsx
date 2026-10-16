import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./App.css";
import App from "./App.tsx";

// Embedded in another page (e.g. an OpenChat channel): lets App.css apply
// layout fixes for the narrower frame without touching the direct site.
if (window.self !== window.top) {
  document.documentElement.classList.add("embedded");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
