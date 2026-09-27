// Клиент JSON-API панели (workers/api/src/panel.ts). Сессия — HttpOnly cookie,
// изменяющие запросы помечаются заголовком X-Panel.

export interface WorkerSummary {
  name: string;
  version: number;
  versions: number;
  createdAt: string;
  updatedAt: string;
  hasCode: boolean;
  assetFiles: number;
  durableObjects: number;
  services: number;
  vars: number;
  secrets: number;
  /** false — workers_dev = false: адреса нет, только service bindings. */
  public: boolean;
}

export interface WorkerDetail extends WorkerSummary {
  mainModule: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  varsList: { name: string; value: string }[];
  /** Только имена: значения секретов сервер не отдаёт. */
  secretsList: string[];
  durableObjectsList: { binding: string; className: string }[];
  servicesList: { binding: string; service: string; entrypoint?: string }[];
  /** Контейнер воркера worker-<имя>; null — нет (воркер без кода или ещё не запускался). */
  runner: { version: number; state: string; status: string } | null;
  assets: {
    files: number;
    binding: string | null;
    config: { html_handling?: string; not_found_handling?: string; run_worker_first?: boolean };
  } | null;
  modules: { name: string; type: string; size: number }[];
}

export interface VersionSummary {
  id: number;
  createdAt: string;
  active: boolean;
  message: string | null;
  codeSize: number;
  assetFiles: number;
}

export interface Session {
  authenticated: boolean;
  rootDomain: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Вызывается при 401 — приложение показывает форму входа. */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(method !== "GET" ? { "x-panel": "1" } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    if (response.status === 401 && path !== "/login") onUnauthorized();
    throw new ApiError(response.status, data.error ?? `HTTP ${response.status}`);
  }
  return data as T;
}

export const api = {
  session: () => request<Session>("GET", "/session"),
  login: (token: string) => request<{ ok: true }>("POST", "/login", { token }),
  logout: () => request<{ ok: true }>("POST", "/logout"),
  workers: () => request<WorkerSummary[]>("GET", "/workers"),
  worker: (name: string) => request<WorkerDetail>("GET", `/workers/${name}`),
  versions: (name: string) => request<VersionSummary[]>("GET", `/workers/${name}/versions`),
  rollback: (name: string, version: number) => request<{ ok: true }>("POST", `/workers/${name}/rollback`, { version }),
  remove: (name: string) => request<{ ok: true }>("DELETE", `/workers/${name}`),
  putSecret: (name: string, secret: string, value: string) =>
    request<{ ok: true; version: number }>("POST", `/workers/${name}/secrets`, { name: secret, value }),
  deleteSecret: (name: string, secret: string) =>
    request<{ ok: true; version: number }>("DELETE", `/workers/${name}/secrets?name=${encodeURIComponent(secret)}`),
  startTail: (name: string) => request<{ id: string; url: string }>("POST", `/workers/${name}/tail`),
  stopTail: (name: string, id: string) => request<{ ok: true }>("DELETE", `/workers/${name}/tail?id=${id}`),
};
