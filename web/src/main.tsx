import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import App from "./App";
import { I18nProvider } from "$lib/i18n";
import { initTheme } from "$lib/theme";

initTheme();

const root = document.getElementById("app");
if (!root) {
  throw new Error("Root element #app not found");
}

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>
);
