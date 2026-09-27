// Durable Objects для панели (раздел «Durable Objects», отдельно от воркеров).
//
// Данные лежат на диске: /data/workers/<воркер>/<воркер>-<класс>/<id>.sqlite(-wal/-shm).
// Список строится по диску, а не по реестру: так видны и «осиротевшие» данные —
// воркер удалён или класс больше не используется, — и их можно удалить.
// Содержимое объекта читает сам контейнер воркера (прослойка, __platformInspect):
// SQLite открыта им, платформа файл не трогает.
import type { Orchestrator } from "./orchestrator";
import type { DurableObjectBinding, Registry } from "./registry";
import { RUNNER_INTERNAL_PORT } from "./runner/bundle";
import { adminToken } from "./runner/token";

export interface DurableEnv {
  API_TOKEN?: string;
  REGISTRY: DurableObjectNamespace<Registry>;
  ORCHESTRATOR: DurableObjectNamespace<Orchestrator>;
  STORAGE: Fetcher;
  RUNNERS: Fetcher;
}

export type NamespaceStatus = "active" | "worker-deleted" | "class-unused";

export interface NamespaceSummary {
  worker: string;
  className: string;
  /** Имя биндинга в env у активной версии (если класс используется). */
  binding: string | null;
  status: NamespaceStatus;
  objects: number;
  size: number;
  modified: string | null;
}

export interface ObjectSummary {
  id: string;
  size: number;
  modified: string | null;
}

/** Старые данные DO (Worker Loader + facets) до перехода на контейнеры. */
export interface LegacySummary {
  files: number;
  size: number;
}

const STORAGE = "http://storage";
const OBJECT_ID = /^[0-9a-f]{64}$/;

type Entry = { name: string; type: string };

async function list(env: DurableEnv, path: string): Promise<Entry[]> {
  const response = await env.STORAGE.fetch(`${STORAGE}${path}`);
  if (!response.ok) {
    await response.body?.cancel();
    return [];
  }
  const entries = (await response.json().catch(() => null)) as Entry[] | null;
  return Array.isArray(entries) ? entries : [];
}

async function stat(env: DurableEnv, path: string): Promise<{ size: number; modified: string | null }> {
  const response = await env.STORAGE.fetch(`${STORAGE}${path}`, { method: "HEAD" });
  const modified = response.headers.get("last-modified");
  return {
    size: Number(response.headers.get("content-length")) || 0,
    modified: modified ? new Date(modified).toISOString() : null,
  };
}

/** Файлы объектов каталога класса → объекты (один объект = <id>.sqlite + -wal/-shm). */
async function objectsIn(env: DurableEnv, dir: string): Promise<ObjectSummary[]> {
  const objects = new Map<string, ObjectSummary>();
  const files = (await list(env, dir)).filter((e) => e.type === "file");
  await Promise.all(files.map(async (file) => {
    const id = file.name.split(".")[0];
    if (!OBJECT_ID.test(id)) return;
    const info = await stat(env, `${dir}/${file.name}`);
    const object = objects.get(id) ?? { id, size: 0, modified: null };
    object.size += info.size;
    if (info.modified && (!object.modified || info.modified > object.modified)) object.modified = info.modified;
    objects.set(id, object);
  }));
  return [...objects.values()].sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
}

function registry(env: DurableEnv) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("main"));
}

export async function listNamespaces(env: DurableEnv): Promise<{ namespaces: NamespaceSummary[]; legacy: LegacySummary | null }> {
  const bindings: Record<string, DurableObjectBinding[]> = await registry(env).durableBindings();
  const namespaces: NamespaceSummary[] = [];
  for (const workerDir of await list(env, "/workers")) {
    if (workerDir.type !== "directory") continue;
    const worker = workerDir.name;
    for (const nsDir of await list(env, `/workers/${worker}`)) {
      if (nsDir.type !== "directory" || !nsDir.name.startsWith(`${worker}-`)) continue;
      const className = nsDir.name.slice(worker.length + 1);
      const objects = await objectsIn(env, `/workers/${worker}/${nsDir.name}`);
      const binding = bindings[worker]?.find((d) => d.className === className)?.binding ?? null;
      namespaces.push({
        worker,
        className,
        binding,
        status: binding ? "active" : worker in bindings ? "class-unused" : "worker-deleted",
        objects: objects.length,
        size: objects.reduce((n, o) => n + o.size, 0),
        modified: objects[0]?.modified ?? null,
      });
    }
  }
  namespaces.sort((a, b) => a.worker.localeCompare(b.worker) || a.className.localeCompare(b.className));
  return { namespaces, legacy: await legacySummary(env) };
}

async function legacySummary(env: DurableEnv): Promise<LegacySummary | null> {
  const root = await env.STORAGE.fetch(`${STORAGE}/platform-Host`);
  if (!root.ok) {
    await root.body?.cancel();
    return null;
  }
  await root.body?.cancel();
  let files = 0;
  let size = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    for (const entry of await list(env, path)) {
      if (entry.type === "file") {
        files++;
        size += (await stat(env, `${path}/${entry.name}`)).size;
      } else if (entry.type === "directory" && depth < 3) {
        await walk(`${path}/${entry.name}`, depth + 1);
      }
    }
  };
  await walk("/platform-Host", 0);
  return { files, size };
}

export async function deleteLegacy(env: DurableEnv): Promise<void> {
  await env.STORAGE.fetch(`${STORAGE}/platform-Host`, { method: "DELETE" });
}

export async function listObjects(env: DurableEnv, worker: string, className: string): Promise<ObjectSummary[]> {
  return objectsIn(env, `/workers/${worker}/${worker}-${className}`);
}

/**
 * Содержимое объекта: читает контейнер воркера. Возможно, только пока класс используется
 * активной версией — иначе класса нет в коде и открыть объект нечем.
 */
export async function inspectObject(
  env: DurableEnv,
  worker: string,
  className: string,
  id: string,
): Promise<{ status: number; body: unknown }> {
  if (!OBJECT_ID.test(id)) return { status: 400, body: { error: "некорректный id" } };
  const classes = await registry(env).durableClasses(worker);
  if (!classes.includes(className)) {
    return { status: 409, body: { error: "Класс не используется активной версией воркера — данные можно только удалить" } };
  }
  const address = (await registry(env).route(worker))?.address;
  if (!address) return { status: 503, body: { error: "Контейнер воркера не запущен" } };
  const response = await env.RUNNERS.fetch(
    `http://${address}:${RUNNER_INTERNAL_PORT}/__platform/do?class=${encodeURIComponent(className)}&id=${id}`,
    { headers: { "x-platform-admin": await adminToken(env.API_TOKEN ?? "", worker) }, signal: AbortSignal.timeout(10_000) },
  );
  const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  return { status: response.ok ? 200 : 502, body };
}

export async function deleteData(env: DurableEnv, worker: string, className: string, id: string | null): Promise<void> {
  if (id !== null && !OBJECT_ID.test(id)) throw new Error("некорректный id");
  await env.ORCHESTRATOR.get(env.ORCHESTRATOR.idFromName("main")).deleteDurableData(worker, className, id);
}
