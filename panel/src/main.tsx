import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, setUnauthorizedHandler, type Session } from "./api";
import { Login } from "./pages/Login";
import { Worker } from "./pages/Worker";
import { WorkersList } from "./pages/WorkersList";
import { linkProps, navigate, useRoute } from "./router";
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
    document.title = route.page === "worker" ? `${route.name} · Воркеры` : "Воркеры · workerd";
  }, [route]);

  if (!session) return null;
  if (!session.authenticated) return <Login onDone={refresh} />;

  return (
    <>
      <header className="topbar">
        <nav className="breadcrumbs" aria-label="Навигация">
          <a className="crumb" {...linkProps("/")}>
            <img src="/favicon.svg" alt="" width={20} height={20} />
            <span>Воркеры</span>
          </a>
          {route.page === "worker" && (
            <>
              <span className="crumb-sep" aria-hidden="true"><Icon name="chevron" size={14} /></span>
              <span className="crumb current">{route.name}</span>
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
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
