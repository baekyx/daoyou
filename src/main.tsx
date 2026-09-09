import * as Sentry from "@sentry/react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { AppWrapper } from "./components/common/PageMeta.tsx";
import "./index.css";

Sentry.init({
  dsn: import.meta.env['VITE_SENTRY_DSN'] as string | undefined,
  environment: import.meta.env.MODE,
});

createRoot(document.getElementById("root")!).render(
  <Sentry.ErrorBoundary
    fallback={({ error, resetError }) => (
      <main className="app-error-fallback" role="alert">
        <h1>页面暂时无法显示</h1>
        <p>请返回上一页或重新加载当前页面。</p>
        {import.meta.env.DEV && (
          <pre>{error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}</pre>
        )}
        <button type="button" onClick={resetError}>重新加载页面</button>
      </main>
    )}
  >
    <AppWrapper>
      <App />
    </AppWrapper>
  </Sentry.ErrorBoundary>
);
