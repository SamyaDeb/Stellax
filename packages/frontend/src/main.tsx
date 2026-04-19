import { Component, StrictMode } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";

interface EBState {
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { error: null };

  static getDerivedStateFromError(error: Error): EBState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            fontFamily: "monospace",
            padding: "2rem",
            color: "#f87171",
            background: "#0f172a",
            minHeight: "100vh",
          }}
        >
          <h2 style={{ fontSize: "1.2rem", marginBottom: "1rem" }}>
            Application Error
          </h2>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem" }}>
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const el = document.getElementById("root");
if (el === null) {
  throw new Error("Root element #root not found");
}

createRoot(el).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
