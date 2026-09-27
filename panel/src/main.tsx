import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, setUnauthorizedHandler, type Session } from "./api";
import { DurableNamespace } from "./pages/DurableNamespace";
import { DurableObjects } from "./pages/DurableObjects";
import { Login } from "./pages/Login";
import { Worker } from "./pages/Worker";
import { WorkersList } from "./pages/WorkersList";
import { href, linkProps, navigate, section, useRoute } from "./router";
import { Icon } from "./ui";
import "./styles.css";

function App() {
  const route = useRoute();
  const [session, setSession] = useState<Session | null>(null);

  const refresh = useCallback(() => {
    api.session().then(setSession).catch(() => setSession({ authenticated: false, rootDomain: "" }));
  }, []);

  useEffect(() => {
    refresh();
    setUnauthorizedHandler(() => setSession((s) => (s ? { ...s, authenticated: false } : s)));
  }, [refresh]);

  useEffect(() => {
    document.title =
      route.page === "worker" ? `${route.name} · Воркеры`
      : route.page === "namespace" ? `${route.className} · Durable Objects`
      : route.page === "durable-objects" ? "Durable Objects · workerd"
      : "Воркеры · workerd";
  }, [route]);

  if (!session) return null;
  if (!session.authenticated) return <Login onDone={refresh} />;

  const current = section(route);
  return (
    <>
      <header className="topbar">
        <a className="crumb" aria-label="Воркеры" {...linkProps("/")}>
          <img src="/favicon.svg" alt="" width={20} height={20} />
        </a>
        <nav className="tabs" aria-label="Разделы">
          <a className={current === "workers" ? "tab active" : "tab"} {...linkProps("/")}>Воркеры</a>
          <a className={current === "durable-objects" ? "tab active" : "tab"} {...linkProps(href({ page: "durable-objects" }))}>
            Durable Objects
          </a>
        </nav>
        <nav className="breadcrumbs" aria-label="Навигация">
          {route.page === "worker" && (
            <>
              <span className="crumb-sep" aria-hidden="true"><Icon name="chevron" size={14} /></span>
              <span className="crumb current">{route.name}</span>
            </>
          )}
          {route.page === "namespace" && (
            <>
              <span className="crumb-sep" aria-hidden="true"><Icon name="chevron" size={14} /></span>
              <span className="crumb current hide-sm">{route.worker} / {route.className}</span>
            </>
          )}
        </nav>
        <span className="grow" />
        <span className="muted small hide-sm">{session.rootDomain}</span>
        <button type="button" className="btn btn-ghost" onClick={async () => {
          await api.logout().catch(() => {});
          navigate("/");
          refresh();
        }}>
          <Icon name="logout" /> <span className="hide-sm">Выйти</span>
        </button>
      </header>

      {route.page === "list" && <WorkersList rootDomain={session.rootDomain} />}
      {route.page === "worker" && <Worker name={route.name} tab={route.tab} rootDomain={session.rootDomain} />}
      {route.page === "durable-objects" && <DurableObjects />}
      {route.page === "namespace" && <DurableNamespace worker={route.worker} className={route.className} />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
