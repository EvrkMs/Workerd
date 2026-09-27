// Оркестратор контейнеров: у каждого воркера с кодом — свой процесс workerd в своём
// контейнере (worker-<имя>). Бесконечный цикл, утечка памяти или падение одного воркера
// не задевают остальные; CPU и память ограничены Docker.
//
// Источник правды — реестр (активная версия). Оркестратор:
//   - после деплоя/отката/смены секретов запускает активную версию и ждёт, пока она
//     ответит; не поднялась — возвращает прежнюю версию и отдаёт ошибку с логом workerd;
//   - раз в RECONCILE_MS сверяет контейнеры с реестром (нет, не та версия, старый образ
//     движка → пересоздать; лишний → удалить) и проверяет здоровье (завис → перезапуск);
//   - по просьбе gateway поднимает контейнер, до которого тот не достучался.
// Сам Docker трогает только контроллер (workers/controller), оркестратор шлёт ему бандлы.
import { DurableObject } from "cloudflare:workers";
import type { Registry } from "./registry";
import { buildBundle, RUNNER_INTERNAL_PORT } from "./runner/bundle";
import { tar } from "./runner/tar";
import { runnerToken } from "./runner/token";

export interface OrchestratorEnv {
  API_TOKEN?: string;
  REGISTRY: DurableObjectNamespace<Registry>;
  /**
   * Частные адреса: контейнеры воркеров (workerd_internal) и контроллер (workerd_control).
   * network-сервис, а не external: тот разрешает имя один раз, и после пересоздания
   * контейнера с новым IP связь теряется. network разрешает имя на каждый запрос.
   */
  RUNNERS: Fetcher;
  /** /data на запись: каталоги workers/<имя> для данных Durable Objects. */
  STORAGE: Fetcher;
}

/** Состояние контейнера от контроллера. */
export interface RunnerState {
  name: string;
  version: number;
  gen: string;
  state: string;
  status: string;
  currentImage: boolean;
  address: string;
}

export type ActivateResult = { ok: true } | { ok: false; error: string };

/** Меняется, когда меняется формат бандла: все контейнеры пересоздаются. */
const BUNDLE_GEN = "2";
const RECONCILE_MS = 15_000;
const START_TIMEOUT_MS = 20_000;
/** Сломанную версию сверка не перезапускает чаще, чем раз в RETRY_FAILED_MS. */
const RETRY_FAILED_MS = 5 * 60_000;
/** Столько проверок здоровья подряд без ответа — и контейнер перезапускается. */
const UNHEALTHY_LIMIT = 2;

export function orchestrator(env: { ORCHESTRATOR: DurableObjectNamespace<Orchestrator> }) {
  return env.ORCHESTRATOR.get(env.ORCHESTRATOR.idFromName("main"));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Orchestrator extends DurableObject<OrchestratorEnv> {
  private readonly locks = new Map<string, Promise<unknown>>();

  // Счётчики — в storage, не в памяти: между будильниками объект выгружается.
  private async unhealthyCount(name: string, next?: number): Promise<number> {
    if (next === undefined) return (await this.ctx.storage.get<number>(`unhealthy:${name}`)) ?? 0;
    if (next === 0) await this.ctx.storage.delete(`unhealthy:${name}`);
    else await this.ctx.storage.put(`unhealthy:${name}`, next);
    return next;
  }

  /** Версия недавно не запустилась — не перезапускать её в цикле. */
  private async recentlyFailed(name: string, version: number): Promise<boolean> {
    const failed = await this.ctx.storage.get<{ version: number; at: number }>(`failed:${name}`);
    return failed?.version === version && Date.now() - failed.at < RETRY_FAILED_MS;
  }

  private registry() {
    return this.env.REGISTRY.get(this.env.REGISTRY.idFromName("main"));
  }

  /** Операции над одним воркером — строго по очереди. */
  private serial<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(name) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(name, next);
    next.finally(() => {
      if (this.locks.get(name) === next) this.locks.delete(name);
    }).catch(() => {});
    return next;
  }

  private async controller(method: string, path: string, body?: BodyInit): Promise<Response> {
    const response = await this.env.RUNNERS.fetch(`http://controller:8090${path}`, {
      method,
      body,
      headers: { authorization: `Bearer ${this.env.API_TOKEN}` },
    });
    if (!response.ok && response.status !== 404) {
      const error = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(`контроллер: ${error?.error ?? `HTTP ${response.status}`}`);
    }
    return response;
  }

  /** Поколение бандла: формат + отпечаток токена (токен контейнера выводится из него). */
  private async gen(): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.env.API_TOKEN ?? ""));
    const hex = Array.from(new Uint8Array(digest).slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
    return `${BUNDLE_GEN}-${hex}`;
  }

  async runners(): Promise<RunnerState[]> {
    return (await (await this.controller("GET", "/runners")).json()) as RunnerState[];
  }

  private async healthy(address: string, timeoutMs = 2000): Promise<boolean> {
    if (!address) return false;
    try {
      const response = await this.env.RUNNERS.fetch(
        `http://${address}:${RUNNER_INTERNAL_PORT}/__platform/health`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  private async logs(name: string): Promise<string> {
    try {
      const response = await this.controller("GET", `/runners/${name}/logs?tail=40`);
      if (!response.ok) return "";
      // workerd при перезапусках пишет одну и ту же ошибку — оставляем уникальные строки
      const lines = (await response.text()).split("\n").map((l) => l.trimEnd()).filter(Boolean);
      return [...new Set(lines)].slice(-15).join("\n");
    } catch {
      return "";
    }
  }

  /** Собирает бандл версии, пересоздаёт контейнер и ждёт ответа. Бросает ошибку с логом. */
  private async start(name: string, version: number): Promise<void> {
    const source = await this.registry().runnerSource(version);
    const token = await runnerToken(this.env.API_TOKEN ?? "", name);
    const bundle = tar(Object.fromEntries(
      Object.entries(buildBundle(name, token, source)).map(([path, content]) => [`runner/${path}`, content]),
    ));

    // подкаталог volume для Durable Objects должен существовать до создания контейнера
    // (файлы с точкой в начале disk-сервис workerd не пишет — отсюда имя без точки)
    const marker = await this.env.STORAGE.fetch(`http://storage/workers/${name}/worker.txt`, { method: "PUT", body: name });
    if (!marker.ok) throw new Error(`не удалось создать /data/workers/${name}: HTTP ${marker.status}`);

    const created = await this.controller("PUT", `/runners/${name}?version=${version}&gen=${await this.gen()}`, bundle);
    const { address } = (await created.json()) as { address: string };

    const started = Date.now();
    const deadline = started + START_TIMEOUT_MS;
    let lastStateCheck = started;
    while (Date.now() < deadline) {
      // код упал при старте — workerd завершился, Docker перезапускает его по кругу; ждать нечего
      if (Date.now() - lastStateCheck > 1500) {
        lastStateCheck = Date.now();
        const runner = (await this.runners()).find((r) => r.name === name);
        if (runner && runner.state !== "running") break;
      }
      if (await this.healthy(address, 1000)) {
        await this.ctx.storage.delete([`failed:${name}`, `unhealthy:${name}`]);
        // gateway и service bindings ходят по IP: новый контейнер — новый адрес, и ни одно
        // соединение из пула к старому (которое повисло бы до таймаута) не используется
        await this.registry().setRunnerAddress(name, address);
        return;
      }
      await sleep(300);
    }
    await this.ctx.storage.put(`failed:${name}`, { version, at: Date.now() });
    const log = await this.logs(name);
    throw new Error(`версия ${version} не запустилась${log ? `:\n${log}` : ""}`);
  }

  /**
   * Активная версия воркера сменилась (деплой, откат, секреты) — запустить её.
   * Не запустилась: вернуть активной previous и поднять её; ошибка уходит в wrangler/панель.
   */
  async activate(name: string, previous: number | null): Promise<ActivateResult> {
    await this.ensureAlarm();
    return this.serial(name, async () => {
      const active = (await this.registry().activeVersions()).find((w) => w.name === name);
      if (!active || !active.hasCode) {
        // воркер удалён или только статика — процесс не нужен
        await this.controller("DELETE", `/runners/${name}`);
        await this.registry().setRunnerAddress(name, null);
        return { ok: true } as const;
      }
      try {
        await this.start(name, active.version);
        return { ok: true } as const;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (previous === null || previous === active.version) return { ok: false, error: message } as const;
        await this.registry().setActive(name, previous);
        try {
          await this.start(name, previous);
        } catch {
          // прежняя версия тоже не поднялась — сверка попробует ещё раз
        }
        return { ok: false, error: `${message}\n\nАктивной осталась версия ${previous}.` } as const;
      }
    });
  }

  async remove(name: string): Promise<void> {
    await this.serial(name, async () => {
      await this.controller("DELETE", `/runners/${name}`);
    });
  }

  /** gateway не достучался до контейнера: поднять, если его нет или он не той версии. */
  async ensure(name: string): Promise<void> {
    await this.ensureAlarm();
    await this.serial(name, async () => {
      const active = (await this.registry().activeVersions()).find((w) => w.name === name);
      if (!active?.hasCode) return;
      const gen = await this.gen();
      const runner = (await this.runners()).find((r) => r.name === name);
      if (runner && runner.version === active.version && runner.gen === gen && runner.currentImage && runner.state === "running") {
        // контейнер на месте: либо ещё стартует, либо перезапустился с другим IP
        if (await this.healthy(runner.address)) await this.registry().setRunnerAddress(name, runner.address);
        return;
      }
      if (await this.recentlyFailed(name, active.version)) return;
      await this.start(name, active.version);
    });
  }

  async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  async alarm(): Promise<void> {
    try {
      await this.reconcile();
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + RECONCILE_MS);
    }
  }

  private async reconcile(): Promise<void> {
    const desired = (await this.registry().activeVersions()).filter((w) => w.hasCode);
    const runners = new Map((await this.runners()).map((r) => [r.name, r]));
    const gen = await this.gen();

    for (const w of desired) {
      const runner = runners.get(w.name);
      runners.delete(w.name);
      const stale = !runner || runner.version !== w.version || runner.gen !== gen || !runner.currentImage
        || runner.state === "exited" || runner.state === "dead" || runner.state === "created";
      if (stale) {
        if (await this.recentlyFailed(w.name, w.version)) continue;
        await this.serial(w.name, () => this.start(w.name, w.version)).catch((e) => {
          console.error(`reconcile ${w.name}@${w.version}: ${e instanceof Error ? e.message : e}`);
        });
        continue;
      }
      if (runner.state !== "running" || this.locks.has(w.name)) continue;
      // Завис (бесконечный цикл): процесс жив, но не отвечает — перезапускаем
      if (await this.healthy(runner.address)) {
        if (await this.unhealthyCount(w.name)) await this.unhealthyCount(w.name, 0);
        // после перезапуска (падение, зависание) у контейнера может быть другой IP
        if ((await this.registry().route(w.name))?.address !== runner.address) {
          await this.registry().setRunnerAddress(w.name, runner.address);
        }
      } else {
        const count = await this.unhealthyCount(w.name, (await this.unhealthyCount(w.name)) + 1);
        if (count >= UNHEALTHY_LIMIT) {
          console.error(`reconcile ${w.name}: не отвечает ${count} раза подряд — перезапуск`);
          await this.unhealthyCount(w.name, 0);
          await this.controller("POST", `/runners/${w.name}/restart`).catch(() => {});
        }
      }
    }
    // контейнеры удалённых воркеров
    for (const name of runners.keys()) {
      await this.serial(name, () => this.controller("DELETE", `/runners/${name}`)).catch(() => {});
    }
  }
}
