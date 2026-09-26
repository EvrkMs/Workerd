// Реестр воркеров платформы — единственный источник правды о том, что задеплоено.
// Один экземпляр ("main"). Каждая загрузка — новая версия; активная версия — у воркера.
import { DurableObject } from "cloudflare:workers";

export type ModuleType = "js" | "cjs" | "text" | "data" | "json" | "wasm";

export interface UploadedModule {
  name: string;
  type: ModuleType;
  content: ArrayBuffer;
}

export interface WorkerMeta {
  mainModule: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  vars: Record<string, unknown>;
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
}

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
    };
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
