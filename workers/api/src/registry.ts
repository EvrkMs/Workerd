// Реестр воркеров платформы — единственный источник правды о том, что задеплоено.
// Один экземпляр ("main"). Каждая загрузка — новая версия; активная версия — у воркера.
import { DurableObject } from "cloudflare:workers";

export type ModuleType = "js" | "cjs" | "text" | "data" | "json" | "wasm";

export interface UploadedModule {
  name: string;
  type: ModuleType;
  content: ArrayBuffer;
}

/** Биндинг Durable Object своего же воркера: env[binding] → класс className. */
export interface DurableObjectBinding {
  binding: string;
  className: string;
}

/**
 * Биндинг другого воркера ([[services]] в wrangler.toml): env[binding] → воркер service,
 * его default-экспорт или именованный entrypoint. Вызов идёт в активную версию цели.
 */
export interface ServiceBinding {
  binding: string;
  service: string;
  entrypoint?: string;
}

/** Настройки статики из wrangler.toml [assets]. */
export interface AssetConfig {
  html_handling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
  not_found_handling?: "single-page-application" | "404-page" | "none";
  run_worker_first?: boolean;
}

/** Статика версии: путь → хэш файла, настройки, имя биндинга (env.ASSETS). */
export interface VersionAssets {
  manifest: Record<string, string>;
  config: AssetConfig;
  binding?: string;
}

/** Файл статики для gateway: хэш (он же имя на диске) и Content-Type. */
export interface AssetFile {
  hash: string;
  contentType: string | null;
}

export interface WorkerMeta {
  /** Пустая строка — у воркера нет кода, только статика. */
  mainModule: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  vars: Record<string, unknown>;
  /** Нет в версиях, загруженных до поддержки DO. */
  durableObjects?: DurableObjectBinding[];
  /** Нет в версиях, загруженных до поддержки service bindings. */
  services?: ServiceBinding[];
  assets?: VersionAssets;
  /** Секреты: имя → значение. Наружу отдаются только имена. Наследуются при деплое. */
  secrets?: Record<string, string>;
  /** wrangler deploy --message или описание служебной версии («Секрет X обновлён») */
  message?: string;
}

export interface WorkerSummary {
  name: string;
  version: number;
  /** Сколько версий хранится в реестре. */
  versions: number;
  createdAt: string;
  updatedAt: string;
  hasCode: boolean;
  assetFiles: number;
  durableObjects: number;
  services: number;
  vars: number;
  secrets: number;
  /** false — у воркера нет адреса <имя>.<домен> (workers_dev = false), только вызовы из других воркеров. */
  public: boolean;
}

export interface VersionSummary {
  id: number;
  createdAt: string;
  active: boolean;
  message: string | null;
  /** Размер модулей кода, байт. */
  codeSize: number;
  assetFiles: number;
}

export interface WorkerDetail extends WorkerSummary {
  mainModule: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  varsList: { name: string; value: string }[];
  /** Только имена — значения секретов из реестра не выходят. */
  secretsList: string[];
  durableObjectsList: DurableObjectBinding[];
  servicesList: ServiceBinding[];
  assets: { files: number; binding: string | null; config: AssetConfig } | null;
  modules: { name: string; type: ModuleType; size: number }[];
}

/** Код версии в формате Worker Loader (только сериализуемые через RPC типы). */
export interface VersionCode {
  compatibilityDate: string;
  compatibilityFlags: string[];
  mainModule: string;
  modules: Record<string, { js: string } | { cjs: string } | { text: string } | { json: unknown } | { data: ArrayBuffer } | { wasm: ArrayBuffer }>;
  env: Record<string, unknown>;
  durableObjects: DurableObjectBinding[];
  services: ServiceBinding[];
  /** Имя биндинга статики (env.ASSETS), если он объявлен. */
  assetsBinding: string | null;
}

/** Всё, что gateway нужно знать о версии, чтобы решить, куда отправить запрос. */
export interface VersionInfo {
  hasCode: boolean;
  assets: { config: AssetConfig; files: Record<string, AssetFile> } | null;
}

/** Сессия загрузки статики (wrangler: assets-upload-session → assets/upload). */
export interface AssetSession {
  worker: string;
  manifest: Record<string, string>;
  /** Сколько хэшей из манифеста ещё не загружено. */
  missing: number;
}

const ASSET_SESSION_TTL_MS = 60 * 60 * 1000;

type SummaryRow = {
  name: string;
  active_version: number;
  versions: number;
  created_at: string;
  updated_at: string;
  public: number;
  meta: string;
};

const SUMMARY_SQL = `
  SELECT w.name, w.active_version, w.created_at, w.updated_at, w.public, v.meta,
         (SELECT count(*) FROM versions x WHERE x.worker = w.name) AS versions
  FROM workers w JOIN versions v ON v.id = w.active_version`;

function toSummary(r: SummaryRow): WorkerSummary {
  const meta = JSON.parse(r.meta) as WorkerMeta;
  return {
    name: r.name,
    version: r.active_version,
    versions: r.versions,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    hasCode: meta.mainModule !== "",
    assetFiles: meta.assets ? Object.keys(meta.assets.manifest).length : 0,
    durableObjects: meta.durableObjects?.length ?? 0,
    services: meta.services?.length ?? 0,
    vars: Object.keys(meta.vars).length,
    secrets: Object.keys(meta.secrets ?? {}).length,
    public: r.public !== 0,
  };
}

/** Имя секрета — как у переменной окружения; "__…" занято платформой. */
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export class Registry extends DurableObject<object> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS workers (
          name           TEXT PRIMARY KEY,
          active_version INTEGER NOT NULL,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS versions (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          worker     TEXT NOT NULL,
          meta       TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS modules (
          version_id INTEGER NOT NULL,
          name       TEXT NOT NULL,
          type       TEXT NOT NULL,
          content    BLOB NOT NULL,
          PRIMARY KEY (version_id, name)
        );
        -- файлы статики лежат на диске: /data/assets/<hash[0:2]>/<hash>
        CREATE TABLE IF NOT EXISTS asset_blobs (
          hash         TEXT PRIMARY KEY,
          content_type TEXT,
          size         INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS asset_sessions (
          id         TEXT PRIMARY KEY,
          worker     TEXT NOT NULL,
          manifest   TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
      // workers_dev: колонка появилась позже — в старой базе её добавляем
      const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(workers)").toArray();
      if (!columns.some((c) => c.name === "public")) {
        this.sql.exec("ALTER TABLE workers ADD COLUMN public INTEGER NOT NULL DEFAULT 1");
      }
    });
  }

  /**
   * Сохраняет новую версию и делает её активной. Возвращает номер версии.
   * Секреты наследуются от активной версии (как в Cloudflare); переданные в meta — поверх.
   */
  deploy(name: string, meta: WorkerMeta, modules: UploadedModule[]): number {
    return this.ctx.storage.transactionSync(() => {
      const secrets = { ...this.activeMeta(name)?.secrets, ...meta.secrets };
      const clash = Object.keys(meta.vars).find((v) => v in secrets);
      if (clash) throw new Error(`имя ${clash} уже занято секретом — переименуй переменную или удали секрет`);
      meta = { ...meta, secrets };

      const now = new Date().toISOString();
      const version = this.sql
        .exec<{ id: number }>(
          "INSERT INTO versions (worker, meta, created_at) VALUES (?, ?, ?) RETURNING id",
          name,
          JSON.stringify(meta),
          now,
        )
        .one().id;

      for (const m of modules) {
        this.sql.exec(
          "INSERT INTO modules (version_id, name, type, content) VALUES (?, ?, ?, ?)",
          version,
          m.name,
          m.type,
          m.content,
        );
      }

      this.sql.exec(
        `INSERT INTO workers (name, active_version, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET active_version = excluded.active_version, updated_at = excluded.updated_at`,
        name,
        version,
        now,
        now,
      );
      return version;
    });
  }

  private activeMeta(name: string): WorkerMeta | null {
    const row = this.sql
      .exec<{ meta: string }>(
        "SELECT v.meta FROM workers w JOIN versions v ON v.id = w.active_version WHERE w.name = ?",
        name,
      )
      .toArray()[0];
    return row ? (JSON.parse(row.meta) as WorkerMeta) : null;
  }

  // --- секреты ---------------------------------------------------------------------

  /** Имена секретов активной версии; null — воркера нет. */
  secretNames(name: string): string[] | null {
    const meta = this.activeMeta(name);
    return meta ? Object.keys(meta.secrets ?? {}).sort() : null;
  }

  /**
   * Меняет секреты: значение — задать, null — удалить. Как в Cloudflare, это новая
   * версия с тем же кодом, и она сразу становится активной (её можно откатить).
   * Возвращает номер версии; null — воркера нет.
   */
  changeSecrets(name: string, changes: Record<string, string | null>): number | null {
    return this.ctx.storage.transactionSync(() => {
      const active = this.activeVersion(name);
      const meta = this.activeMeta(name);
      if (active === null || !meta) return null;

      const secrets = { ...meta.secrets };
      for (const [key, value] of Object.entries(changes)) {
        if (!SECRET_NAME.test(key) || key.startsWith("__")) throw new Error(`недопустимое имя секрета: ${key}`);
        if (value !== null && key in meta.vars) throw new Error(`имя ${key} уже занято переменной из [vars]`);
        if (value === null) delete secrets[key];
        else secrets[key] = value;
      }

      const set = Object.entries(changes).filter(([, v]) => v !== null).map(([k]) => k);
      const removed = Object.entries(changes).filter(([, v]) => v === null).map(([k]) => k);
      const message = [
        set.length ? `Секрет ${set.join(", ")} обновлён` : "",
        removed.length ? `Секрет ${removed.join(", ")} удалён` : "",
      ].filter(Boolean).join("; ");

      const now = new Date().toISOString();
      const version = this.sql
        .exec<{ id: number }>(
          "INSERT INTO versions (worker, meta, created_at) VALUES (?, ?, ?) RETURNING id",
          name,
          JSON.stringify({ ...meta, secrets, message } satisfies WorkerMeta),
          now,
        )
        .one().id;
      this.sql.exec(
        "INSERT INTO modules (version_id, name, type, content) SELECT ?, name, type, content FROM modules WHERE version_id = ?",
        version,
        active,
      );
      this.sql.exec("UPDATE workers SET active_version = ?, updated_at = ? WHERE name = ?", version, now, name);
      return version;
    });
  }

  activeVersion(name: string): number | null {
    const row = this.sql
      .exec<{ active_version: number }>("SELECT active_version FROM workers WHERE name = ?", name)
      .toArray()[0];
    return row?.active_version ?? null;
  }

  /** Для gateway: активная версия и открыт ли адрес <имя>.<домен>; null — воркера нет. */
  route(name: string): { version: number; public: boolean } | null {
    const row = this.sql
      .exec<{ active_version: number; public: number }>("SELECT active_version, public FROM workers WHERE name = ?", name)
      .toArray()[0];
    return row ? { version: row.active_version, public: row.public !== 0 } : null;
  }

  /** workers_dev в wrangler.toml (wrangler шлёт после каждого деплоя). false — воркер только для биндингов. */
  setPublic(name: string, enabled: boolean): boolean {
    return this.sql.exec("UPDATE workers SET public = ? WHERE name = ?", enabled ? 1 : 0, name).rowsWritten > 0;
  }

  code(version: number): VersionCode {
    const row = this.sql
      .exec<{ meta: string }>("SELECT meta FROM versions WHERE id = ?", version)
      .toArray()[0];
    if (!row) throw new Error(`version ${version} not found`);
    const meta = JSON.parse(row.meta) as WorkerMeta;

    const decoder = new TextDecoder();
    const modules: VersionCode["modules"] = {};
    for (const m of this.sql.exec<{ name: string; type: ModuleType; content: ArrayBuffer }>(
      "SELECT name, type, content FROM modules WHERE version_id = ?",
      version,
    )) {
      switch (m.type) {
        case "js": modules[m.name] = { js: decoder.decode(m.content) }; break;
        case "cjs": modules[m.name] = { cjs: decoder.decode(m.content) }; break;
        case "text": modules[m.name] = { text: decoder.decode(m.content) }; break;
        case "json": modules[m.name] = { json: JSON.parse(decoder.decode(m.content)) }; break;
        case "data": modules[m.name] = { data: m.content }; break;
        case "wasm": modules[m.name] = { wasm: m.content }; break;
      }
    }

    return {
      compatibilityDate: meta.compatibilityDate,
      compatibilityFlags: meta.compatibilityFlags,
      mainModule: meta.mainModule,
      modules,
      env: { ...meta.vars, ...meta.secrets },
      durableObjects: meta.durableObjects ?? [],
      services: meta.services ?? [],
      assetsBinding: meta.assets?.binding ?? null,
    };
  }

  info(version: number): VersionInfo {
    const row = this.sql
      .exec<{ meta: string }>("SELECT meta FROM versions WHERE id = ?", version)
      .toArray()[0];
    if (!row) throw new Error(`version ${version} not found`);
    const meta = JSON.parse(row.meta) as WorkerMeta;
    if (!meta.assets) return { hasCode: meta.mainModule !== "", assets: null };

    const types = new Map<string, string | null>();
    for (const b of this.sql.exec<{ hash: string; content_type: string | null }>(
      `SELECT hash, content_type FROM asset_blobs
       WHERE hash IN (SELECT value FROM json_each(?))`,
      JSON.stringify(Object.values(meta.assets.manifest)),
    )) {
      types.set(b.hash, b.content_type);
    }
    const files: Record<string, AssetFile> = {};
    for (const [path, hash] of Object.entries(meta.assets.manifest)) {
      files[path] = { hash, contentType: types.get(hash) ?? null };
    }
    return { hasCode: meta.mainModule !== "", assets: { config: meta.assets.config, files } };
  }

  // --- статика -----------------------------------------------------------------

  /** Начинает загрузку: возвращает id сессии и хэши, которых ещё нет на диске. */
  startAssetSession(worker: string, manifest: Record<string, string>): { id: string; missing: string[] } {
    const hashes = [...new Set(Object.values(manifest))];
    const present = new Set(
      this.sql
        .exec<{ hash: string }>(
          "SELECT hash FROM asset_blobs WHERE hash IN (SELECT value FROM json_each(?))",
          JSON.stringify(hashes),
        )
        .toArray()
        .map((r) => r.hash),
    );
    const id = crypto.randomUUID();
    const now = Date.now();
    this.sql.exec("DELETE FROM asset_sessions WHERE expires_at < ?", now);
    this.sql.exec(
      "INSERT INTO asset_sessions (id, worker, manifest, expires_at) VALUES (?, ?, ?, ?)",
      id,
      worker,
      JSON.stringify(manifest),
      now + ASSET_SESSION_TTL_MS,
    );
    return { id, missing: hashes.filter((h) => !present.has(h)) };
  }

  assetSession(id: string): AssetSession | null {
    const row = this.sql
      .exec<{ worker: string; manifest: string; expires_at: number }>(
        "SELECT worker, manifest, expires_at FROM asset_sessions WHERE id = ?",
        id,
      )
      .toArray()[0];
    if (!row || row.expires_at < Date.now()) return null;
    const manifest = JSON.parse(row.manifest) as Record<string, string>;
    const hashes = [...new Set(Object.values(manifest))];
    const present = this.sql
      .exec<{ n: number }>(
        "SELECT count(*) AS n FROM asset_blobs WHERE hash IN (SELECT value FROM json_each(?))",
        JSON.stringify(hashes),
      )
      .one().n;
    return { worker: row.worker, manifest, missing: hashes.length - present };
  }

  /** Файл уже записан на диск — отмечаем его как доступный. */
  recordAssetBlob(hash: string, contentType: string | null, size: number): void {
    this.sql.exec(
      "INSERT INTO asset_blobs (hash, content_type, size) VALUES (?, ?, ?) ON CONFLICT (hash) DO NOTHING",
      hash,
      contentType,
      size,
    );
  }

  endAssetSession(id: string): void {
    this.sql.exec("DELETE FROM asset_sessions WHERE id = ?", id);
  }

  list(): WorkerSummary[] {
    return this.sql
      .exec<SummaryRow>(`${SUMMARY_SQL} ORDER BY w.name`)
      .toArray()
      .map(toSummary);
  }

  /** Всё о воркере и его активной версии — для панели. */
  detail(name: string): WorkerDetail | null {
    const row = this.sql.exec<SummaryRow>(`${SUMMARY_SQL} WHERE w.name = ?`, name).toArray()[0];
    if (!row) return null;
    const meta = JSON.parse(row.meta) as WorkerMeta;
    const modules = this.sql
      .exec<{ name: string; type: ModuleType; size: number }>(
        "SELECT name, type, length(content) AS size FROM modules WHERE version_id = ? ORDER BY name",
        row.active_version,
      )
      .toArray();
    return {
      ...toSummary(row),
      mainModule: meta.mainModule,
      compatibilityDate: meta.compatibilityDate,
      compatibilityFlags: meta.compatibilityFlags,
      secretsList: Object.keys(meta.secrets ?? {}).sort(),
      varsList: Object.entries(meta.vars).map(([name, value]) => ({
        name,
        value: typeof value === "string" ? value : JSON.stringify(value),
      })),
      durableObjectsList: meta.durableObjects ?? [],
      servicesList: meta.services ?? [],
      assets: meta.assets
        ? {
            files: Object.keys(meta.assets.manifest).length,
            binding: meta.assets.binding ?? null,
            config: meta.assets.config,
          }
        : null,
      modules,
    };
  }

  versionsOf(name: string): VersionSummary[] {
    const active = this.activeVersion(name);
    return this.sql
      .exec<{ id: number; created_at: string; meta: string; code_size: number | null }>(
        `SELECT v.id, v.created_at, v.meta,
                (SELECT sum(length(content)) FROM modules m WHERE m.version_id = v.id) AS code_size
         FROM versions v WHERE v.worker = ? ORDER BY v.id DESC`,
        name,
      )
      .toArray()
      .map((r) => {
        const meta = JSON.parse(r.meta) as WorkerMeta;
        return {
          id: r.id,
          createdAt: r.created_at,
          active: r.id === active,
          message: meta.message ?? null,
          codeSize: r.code_size ?? 0,
          assetFiles: meta.assets ? Object.keys(meta.assets.manifest).length : 0,
        };
      });
  }

  /** Откат/переключение: делает активной одну из уже загруженных версий. */
  setActive(name: string, version: number): boolean {
    const owned = this.sql
      .exec("SELECT 1 FROM versions WHERE id = ? AND worker = ?", version, name)
      .toArray().length > 0;
    if (!owned) return false;
    this.sql.exec(
      "UPDATE workers SET active_version = ?, updated_at = ? WHERE name = ?",
      version,
      new Date().toISOString(),
      name,
    );
    return true;
  }

  /** Удаляет воркер со всеми версиями. Возвращает false, если такого не было. */
  remove(name: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      const existed = this.sql.exec("SELECT 1 FROM workers WHERE name = ?", name).toArray().length > 0;
      this.sql.exec("DELETE FROM modules WHERE version_id IN (SELECT id FROM versions WHERE worker = ?)", name);
      this.sql.exec("DELETE FROM versions WHERE worker = ?", name);
      this.sql.exec("DELETE FROM workers WHERE name = ?", name);
      return existed;
    });
  }
}
