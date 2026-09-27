// Маленький роутер на History API: пути панели простые, отдельная библиотека не нужна.
import { useEffect, useState } from "react";

export type Route =
  | { page: "list" }
  | { page: "worker"; name: string; tab: WorkerTab }
  | { page: "durable-objects" }
  | { page: "namespace"; worker: string; className: string };

export type WorkerTab = "overview" | "versions" | "logs" | "settings";

const TABS: WorkerTab[] = ["overview", "versions", "logs", "settings"];

export function parse(pathname: string): Route {
  const match = pathname.match(/^\/workers\/([a-z0-9-]+)(?:\/([a-z]+))?\/?$/);
  if (match) {
    const tab = (match[2] ?? "overview") as WorkerTab;
    return { page: "worker", name: match[1], tab: TABS.includes(tab) ? tab : "overview" };
  }
  const ns = pathname.match(/^\/durable-objects\/([a-z0-9-]+)\/([A-Za-z_$][\w$]*)\/?$/);
  if (ns) return { page: "namespace", worker: ns[1], className: ns[2] };
  if (/^\/durable-objects\/?$/.test(pathname)) return { page: "durable-objects" };
  return { page: "list" };
}

export function href(route: Route): string {
  switch (route.page) {
    case "list": return "/";
    case "durable-objects": return "/durable-objects";
    case "namespace": return `/durable-objects/${route.worker}/${route.className}`;
    case "worker": return route.tab === "overview" ? `/workers/${route.name}` : `/workers/${route.name}/${route.tab}`;
  }
}

/** Раздел панели для переключателя в шапке. */
export function section(route: Route): "workers" | "durable-objects" {
  return route.page === "durable-objects" || route.page === "namespace" ? "durable-objects" : "workers";
}

export function navigate(to: string) {
  if (to === location.pathname) return;
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.pathname));
  useEffect(() => {
    const update = () => setRoute(parse(location.pathname));
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return route;
}

/** Ссылка, которая переходит без перезагрузки страницы (Ctrl/⌘+клик — как обычно). */
export function linkProps(to: string) {
  return {
    href: to,
    onClick: (event: React.MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(to);
    },
  };
}
