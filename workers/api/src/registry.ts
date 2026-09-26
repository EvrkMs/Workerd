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
  assets?: VersionAssets;
}

export interface WorkerSummary {
  name: string;
  version: number;
  /** Сколько версий хранится в реестре. */
  versions: number;
  createdAt: string;
  updatedAt: string;
}

/** Код версии в формате Worker Loader (только сериализуемые через RPC типы). */
export interface VersionCode {
  compatibilityDate: string;
  compatibilityFlags: string[];
  mainModule: string;
  modules: Record<string, { js: string } | { cjs: string } | { text: string } | { json: unknown } | { data: ArrayBuffer } | { wasm: ArrayBuffer }>;
  env: Record<string, unknown>;
  durableObjects: DurableObjectBinding[];
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
    });
  }

  /** Сохраняет новую версию и делает её активной. Возвращает номер версии. */
  deploy(name: string, meta: WorkerMeta, modules: UploadedModule[]): number {
    return this.ctx.storage.transactionSync(() => {
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

  activeVersion(name: string): number | null {
    const row = this.sql
      .exec<{ active_version: number }>("SELECT active_version FROM workers WHERE name = ?", name)
      .toArray()[0];
    return row?.active_version ?? null;
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
      env: meta.vars,
      durableObjects: meta.durableObjects ?? [],
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
      .exec<{ name: string; active_version: number; versions: number; created_at: string; updated_at: string }>(
        `SELECT w.name, w.active_version, w.created_at, w.updated_at,
                (SELECT count(*) FROM versions v WHERE v.worker = w.name) AS versions
         FROM workers w ORDER BY w.name`,
      )
      .toArray()
      .map((r) => ({
        name: r.name,
        version: r.active_version,
        versions: r.versions,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
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
