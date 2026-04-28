import type { TrackionClientOptions } from "@trackion/js";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { TrackionProvider } from "@trackion/js/react";
import App from "./App.tsx";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; fallback: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Error caught by boundary:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }

    return this.props.children;
  }
}

function ErrorFallback() {
  return (
    <div
      style={{
        padding: "2rem",
        textAlign: "center",
        background: "#fee2e2",
        border: "1px solid #fecaca",
        borderRadius: "0.5rem",
        margin: "2rem",
      }}
    >
      <h2 style={{ color: "#dc2626" }}>Something went wrong</h2>
      <p>We've automatically reported this error.</p>
      <button
        onClick={() => window.location.reload()}
        style={{
          marginTop: "1rem",
          padding: "0.5rem 1rem",
          backgroundColor: "#dc2626",
          color: "white",
          border: "none",
          borderRadius: "0.25rem",
          cursor: "pointer",
        }}
      >
        Reload Page
      </button>
    </div>
  );
}

const trackionConfig: TrackionClientOptions = {
  serverUrl: "http://localhost:8000", // Update this to your Trackion server
  apiKey: "439e7cbd-0461-5ef5-9e87-9d31db35a617", // Update this to your API key
  userId: "demo_user",
  autoPageview: true,
  batchSize: 10,
  flushIntervalMs: 3000,
  replay: {
    enabled: true,
  },
  debug: true,
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <TrackionProvider options={trackionConfig}>
        <ErrorBoundary fallback={<ErrorFallback />}>
          <App />
        </ErrorBoundary>
      </TrackionProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
