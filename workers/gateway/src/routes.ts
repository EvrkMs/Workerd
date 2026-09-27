import type { Env } from "./env";
import { registry } from "./env";

// Кэш «имя → активная версия и адрес контейнера», чтобы не ходить в реестр на каждый
// запрос. После деплоя новая версия начинает отвечать не позже чем через ROUTE_TTL_MS.
const ROUTE_TTL_MS = 1000;
const routes = new Map<string, { route: WorkerRoute | null; until: number }>();

export interface WorkerRoute {
  version: number;
  /** false — workers_dev = false: адреса <имя>.<домен> нет, только service bindings. */
  public: boolean;
  /** IP контейнера воркера; null — ещё не запущен. */
  address: string | null;
}

export async function workerRoute(env: Env, name: string, fresh = false): Promise<WorkerRoute | null> {
  const cached = routes.get(name);
  if (!fresh && cached && cached.until > Date.now()) return cached.route;
  const route = await registry(env).route(name);
  routes.set(name, { route, until: Date.now() + ROUTE_TTL_MS });
  return route;
}
