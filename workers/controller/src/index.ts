// Контроллер контейнеров воркеров. Единственный компонент с доступом к Docker
// (unix-сокет), поэтому он:
//   - не смотрит наружу: сеть workerd_control, где кроме него только платформа;
//   - принимает запросы только с токеном платформы;
//   - спецификацию контейнера собирает сам: фиксированный образ, пользователь, лимиты,
//     сеть, volume. От платформы приходят только имя воркера, версия и бандл (tar в /app/runner).
//
// Контейнер worker-<имя>: образ движка, `workerd serve /app/runner/config.capnp`,
// /data — подкаталог workers/<имя> volume платформы (данные Durable Objects).

interface Env {
  DOCKER: Fetcher;
  TOKEN?: string;
  RUNNER_IMAGE?: string;
  DATA_VOLUME?: string;
  NETWORK?: string;
  RUNNER_MEMORY_MB?: string;
  RUNNER_CPUS?: string;
}

/** Docker Engine API; 1.45+ нужен для VolumeOptions.Subpath. */
const API = "http://docker/v1.47";
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const LABEL = "platform.worker";

export interface RunnerState {
  name: string;
  version: number;
  gen: string;
  /** created | running | restarting | exited | dead … */
  state: string;
  status: string;
  /** false — контейнер собран из старого образа движка (обновление платформы). */
  currentImage: boolean;
  /** IP в сети воркеров (пусто, если контейнер не запущен). */
  address: string;
}

class DockerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function docker(env: Env, method: string, path: string, body?: unknown, contentType = "application/json"): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = contentType === "application/json" ? JSON.stringify(body) : (body as BodyInit);
    init.headers = { "content-type": contentType };
  }
  return env.DOCKER.fetch(`${API}${path}`, init);
}

async function check(response: Response, allow: number[] = []): Promise<Response> {
  if (response.ok || allow.includes(response.status)) return response;
  const text = await response.text();
  let message = text;
  try {
    message = (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    // не JSON
  }
  throw new DockerError(response.status, `docker: ${message}`);
}

function containerName(worker: string): string {
  return `worker-${worker}`;
}

async function imageId(env: Env): Promise<string> {
  const image = env.RUNNER_IMAGE ?? "workerd-controller:local";
  const info = (await (await check(await docker(env, "GET", `/images/${encodeURIComponent(image)}/json`))).json()) as { Id: string };
  return info.Id;
}

async function list(env: Env): Promise<RunnerState[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [LABEL] }));
  const containers = (await (await check(await docker(env, "GET", `/containers/json?all=1&filters=${filters}`))).json()) as {
    Labels: Record<string, string>;
    State: string;
    Status: string;
    ImageID: string;
    NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
  }[];
  const current = await imageId(env);
  const network = env.NETWORK ?? "workerd_internal";
  return containers.map((c) => ({
    name: c.Labels[LABEL],
    version: Number(c.Labels["platform.version"]),
    gen: c.Labels["platform.gen"] ?? "",
    state: c.State,
    status: c.Status,
    currentImage: c.ImageID === current,
    address: c.NetworkSettings?.Networks?.[network]?.IPAddress ?? "",
  }));
}

async function remove(env: Env, worker: string): Promise<boolean> {
  const name = containerName(worker);
  // сначала мягкая остановка: объекты успеют дописать данные
  await check(await docker(env, "POST", `/containers/${name}/stop?t=5`), [304, 404]);
  const response = await check(await docker(env, "DELETE", `/containers/${name}?force=true`), [404]);
  return response.status !== 404;
}

/** Создаёт и запускает контейнер; возвращает его IP в сети воркеров. */
async function create(env: Env, worker: string, version: number, gen: string, bundle: ArrayBuffer): Promise<string> {
  await remove(env, worker);
  const name = containerName(worker);
  const network = env.NETWORK ?? "workerd_internal";
  const memoryMb = Number(env.RUNNER_MEMORY_MB) || 256;
  const cpus = Number(env.RUNNER_CPUS) || 1;

  const created = (await (
    await check(
      await docker(env, "POST", `/containers/create?name=${name}`, {
        Image: env.RUNNER_IMAGE ?? "workerd-controller:local",
        User: "10001:10001",
        Entrypoint: ["workerd", "serve", "/app/runner/config.capnp", "--verbose"],
        Cmd: [],
        WorkingDir: "/app",
        Labels: {
          [LABEL]: worker,
          "platform.version": String(version),
          "platform.gen": gen,
          // метки compose приходят из образа (его собирает compose) — затираем, иначе
          // `docker compose up` сочтёт контейнер копией контроллера и удалит лишние
          "com.docker.compose.project": "",
          "com.docker.compose.service": "",
          "com.docker.compose.oneoff": "",
          "com.docker.compose.container-number": "",
          "com.docker.compose.config-hash": "",
        },
        HostConfig: {
          NetworkMode: network,
          RestartPolicy: { Name: "unless-stopped" },
          Memory: memoryMb * 1024 * 1024,
          MemorySwap: memoryMb * 1024 * 1024,
          NanoCpus: Math.round(cpus * 1e9),
          PidsLimit: 256,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } },
          Mounts: [
            {
              Type: "volume",
              Source: env.DATA_VOLUME ?? "workerd_workerd_data",
              Target: "/data",
              VolumeOptions: { Subpath: `workers/${worker}` },
            },
          ],
        },
        NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [name] } } },
      }),
    )
  ).json()) as { Id: string };

  // файлы воркера — до старта, в /app/runner
  await check(await docker(env, "PUT", `/containers/${created.Id}/archive?path=/app`, bundle, "application/x-tar"));
  await check(await docker(env, "POST", `/containers/${created.Id}/start`));
  const info = (await (await check(await docker(env, "GET", `/containers/${created.Id}/json`))).json()) as {
    NetworkSettings: { Networks: Record<string, { IPAddress?: string }> };
  };
  return info.NetworkSettings.Networks[network]?.IPAddress ?? "";
}

/** Логи контейнера: Docker отдаёт stdout/stderr кадрами по 8 байт заголовка. */
async function logs(env: Env, worker: string, tail: number): Promise<string> {
  const response = await check(
    await docker(env, "GET", `/containers/${containerName(worker)}/logs?stdout=1&stderr=1&tail=${tail}`),
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  const decoder = new TextDecoder();
  let out = "";
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0);
    out += decoder.decode(bytes.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return out.replace(/\r/g, "\n").replace(/\n{2,}/g, "\n");
}

export default {
  async fetch(request, env) {
    if (!env.TOKEN || request.headers.get("authorization") !== `Bearer ${env.TOKEN}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/runners") return Response.json(await list(env));

      const match = url.pathname.match(/^\/runners\/([^/]+)(\/logs|\/restart)?$/);
      if (!match || !NAME.test(match[1])) return Response.json({ error: "not found" }, { status: 404 });
      const [, worker, action = ""] = match;

      if (request.method === "PUT" && action === "") {
        const version = Number(url.searchParams.get("version"));
        const gen = url.searchParams.get("gen") ?? "";
        if (!Number.isInteger(version) || version <= 0 || !/^[\w.-]{0,64}$/.test(gen)) {
          return Response.json({ error: "bad version" }, { status: 400 });
        }
        const address = await create(env, worker, version, gen, await request.arrayBuffer());
        return Response.json({ ok: true, address });
      }
      if (request.method === "DELETE" && action === "") return Response.json({ ok: await remove(env, worker) });
      if (request.method === "POST" && action === "/restart") {
        await check(await docker(env, "POST", `/containers/${containerName(worker)}/restart?t=5`));
        return Response.json({ ok: true });
      }
      if (request.method === "GET" && action === "/logs") {
        const tail = Math.min(Number(url.searchParams.get("tail")) || 50, 500);
        return new Response(await logs(env, worker, tail));
      }
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (e) {
      const status = e instanceof DockerError && e.status === 404 ? 404 : 500;
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
    }
  },
} satisfies ExportedHandler<Env>;
