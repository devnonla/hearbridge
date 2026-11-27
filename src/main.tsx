import { App as NonlaApp, setColorPreference } from "devnonla-ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// HearBridge luôn dùng giao diện sáng.
setColorPreference("light");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NonlaApp className="h-dvh bg-background text-foreground">
      <App />
    </NonlaApp>
  </StrictMode>,
);
