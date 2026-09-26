import { useState } from "react";
import { api, type VersionSummary, type WorkerDetail } from "../api";
import { bytes, plural } from "../format";
import { href, linkProps, navigate, type WorkerTab } from "../router";
import { useAsync } from "../useAsync";
import { Badge, Card, ConfirmDelete, CopyButton, Empty, ErrorNote, Icon, TimeAgo } from "../ui";
import { Logs } from "./Logs";

const TABS: { id: WorkerTab; label: string }[] = [
  { id: "overview", label: "Обзор" },
  { id: "versions", label: "Версии" },
  { id: "logs", label: "Логи" },
  { id: "settings", label: "Настройки" },
];

export function Worker({ name, tab, rootDomain }: { name: string; tab: WorkerTab; rootDomain: string }) {
  const worker = useAsync(() => api.worker(name), [name]);
  const versions = useAsync(() => api.versions(name), [name]);
  const url = `https://${name}.${rootDomain}`;
  const reload = () => {
    worker.reload();
    versions.reload();
  };

  return (
    <>
      <nav className="subnav">
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <a key={t.id} role="tab" aria-selected={t.id === tab} className={t.id === tab ? "tab active" : "tab"}
              {...linkProps(href({ page: "worker", name, tab: t.id }))}>
              {t.label}
            </a>
          ))}
        </div>
        <a className="btn btn-primary" href={url} target="_blank" rel="noreferrer">
          <Icon name="globe" /> <span className="hide-sm">Открыть</span> <Icon name="external" size={12} />
        </a>
      </nav>

      <main className="page">
        {worker.error != null && <ErrorNote error={worker.error} />}
        {worker.data && tab === "overview" && (
          <Overview worker={worker.data} versions={versions.data} url={url} />
        )}
        {worker.data && tab === "versions" && (
          <Versions worker={worker.data} versions={versions.data} error={versions.error} onChanged={reload} />
        )}
        {tab === "logs" && <Logs name={name} />}
        {worker.data && tab === "settings" && <Settings worker={worker.data} />}
        {worker.loading && !worker.data && <div className="skeleton" style={{ height: 160 }} />}
      </main>
    </>
  );
}

// --- Обзор ---------------------------------------------------------------------------

function Overview({ worker: w, versions, url }: { worker: WorkerDetail; versions: VersionSummary[] | null; url: string }) {
  return (
    <>
      <div className="status-bar">
        <Icon name="globe" size={18} />
        <a href={url} target="_blank" rel="noreferrer">{url.replace("https://", "")}</a>
        <span className="grow" />
        <span className="muted nowrap">v{w.version} · обновлён <TimeAgo iso={w.updatedAt} /></span>
      </div>

      <div className="columns">
        <div className="column-main">
          <Card title="Биндинги" flush>
            <Bindings worker={w} />
          </Card>

          <Card title="Версии" flush action={
            <a className="subtle-link" {...linkProps(href({ page: "worker", name: w.name, tab: "versions" }))}>
              Все <Icon name="arrow" size={12} />
            </a>
          }>
            {versions ? <VersionRows versions={versions.slice(0, 5)} /> : <div className="skeleton" />}
          </Card>
        </div>

        <aside className="column-aside">
          <Card title="Домены">
            <dl className="fields">
              <dt>Адрес</dt>
              <dd><span className="truncate">{url.replace("https://", "")}</span><CopyButton text={url} /></dd>
            </dl>
          </Card>
          <Card title="Сведения">
            <dl className="fields">
              <dt>Создан</dt>
              <dd><TimeAgo iso={w.createdAt} /></dd>
              <dt>Код</dt>
              <dd>{w.hasCode ? <code>{w.mainModule}</code> : <span className="muted">нет, только статика</span>}</dd>
              <dt>Совместимость</dt>
              <dd><code>{w.compatibilityDate}</code></dd>
              {w.compatibilityFlags.length > 0 && (
                <>
                  <dt>Флаги</dt>
                  <dd className="wrap">{w.compatibilityFlags.map((f) => <code key={f}>{f}</code>)}</dd>
                </>
              )}
            </dl>
          </Card>
        </aside>
      </div>
    </>
  );
}

function Bindings({ worker: w }: { worker: WorkerDetail }) {
  const rows = [
    ...w.durableObjectsList.map((d) => ({ name: d.binding, kind: "Durable Object", value: d.className, icon: "box" as const })),
    ...(w.assets
      ? [{
          name: w.assets.binding ?? "—",
          kind: "Статика",
          value: `${w.assets.files} ${plural(w.assets.files, "файл", "файла", "файлов")}${
            w.assets.config.not_found_handling ? ` · ${w.assets.config.not_found_handling}` : ""
          }`,
          icon: "file" as const,
        }]
      : []),
    ...w.varsList.map((v) => ({ name: v.name, kind: "Переменная", value: v.value, icon: "key" as const })),
  ];
  if (rows.length === 0) return <Empty>Биндингов нет</Empty>;
  return (
    <table className="table">
      <thead><tr><th>Имя в env</th><th className="hide-sm">Тип</th><th>Значение</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.kind}:${r.name}`}>
            <td><span className="cell-icon"><Icon name={r.icon} size={14} /><code>{r.name}</code></span></td>
            <td className="muted nowrap hide-sm">{r.kind}</td>
            <td className="truncate-cell"><span title={r.value}>{r.value}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VersionRows({ versions, onActivate, busy }: {
  versions: VersionSummary[];
  onActivate?: (v: VersionSummary) => void;
  busy?: number | null;
}) {
  if (versions.length === 0) return <Empty>Версий нет</Empty>;
  return (
    <ul className="version-list">
      {versions.map((v) => (
        <li key={v.id} className={v.active ? "version active" : "version"}>
          <span className="version-marker" aria-hidden="true" />
          <span className="version-id">
            <code>v{v.id}</code>
            <CopyButton text={String(v.id)} label="Копировать номер версии" />
          </span>
          <span className="version-message">
            {v.message ?? <span className="muted italic">Деплой через wravler</span>}
          </span>
          <span className="version-meta muted">
            {v.codeSize > 0 && bytes(v.codeSize)}
            {v.assetFiles > 0 && ` · ${v.assetFiles} ${plural(v.assetFiles, "файл", "файла", "файлов")}`}
          </span>
          {v.active ? (
            <Badge tone="green">Активна</Badge>
          ) : onActivate ? (
            <button type="button" className="btn btn-small" disabled={busy != null} onClick={() => onActivate(v)}>
              {busy === v.id ? "…" : "Сделать активной"}
            </button>
          ) : null}
          <span className="muted nowrap version-time"><TimeAgo iso={v.createdAt} /></span>
        </li>
      ))}
    </ul>
  );
}

// --- Версии --------------------------------------------------------------------------

function Versions({ worker, versions, error, onChanged }: {
  worker: WorkerDetail;
  versions: VersionSummary[] | null;
  error: unknown;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  return (
    <>
      <p className="muted">
        Каждый <code>wravler deploy</code> — новая версия. «Сделать активной» переключает воркер на
        выбранную версию сразу, без передеплоя (откат). Данные Durable Objects при этом не меняются.
      </p>
      {error != null && <ErrorNote error={error} />}
      {actionError != null && <ErrorNote error={actionError} />}
      <Card flush>
        {versions ? (
          <VersionRows versions={versions} busy={busy}
            onActivate={async (v) => {
              setBusy(v.id);
              setActionError(null);
              try {
                await api.rollback(worker.name, v.id);
                onChanged();
              } catch (e) {
                setActionError(e);
              } finally {
                setBusy(null);
              }
            }} />
        ) : (
          <div className="skeleton" />
        )}
      </Card>
    </>
  );
}

// --- Настройки -------------------------------------------------------------------------

function Settings({ worker: w }: { worker: WorkerDetail }) {
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <Card title="Модули кода активной версии" flush>
        {w.modules.length === 0 ? (
          <Empty>У воркера нет кода — только статика</Empty>
        ) : (
          <table className="table">
            <thead><tr><th>Модуль</th><th>Тип</th><th className="num">Размер</th></tr></thead>
            <tbody>
              {w.modules.map((m) => (
                <tr key={m.name}>
                  <td><code>{m.name}</code>{m.name === w.mainModule && <> <Badge>главный</Badge></>}</td>
                  <td className="muted">{m.type}</td>
                  <td className="num">{bytes(m.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {w.assets && (
        <Card title="Статика">
          <dl className="fields">
            <dt>Файлов</dt><dd>{w.assets.files}</dd>
            <dt>Биндинг</dt><dd>{w.assets.binding ? <code>{w.assets.binding}</code> : <span className="muted">нет</span>}</dd>
            <dt>html_handling</dt><dd><code>{w.assets.config.html_handling ?? "auto-trailing-slash"}</code></dd>
            <dt>not_found_handling</dt><dd><code>{w.assets.config.not_found_handling ?? "none"}</code></dd>
            <dt>run_worker_first</dt><dd><code>{String(w.assets.config.run_worker_first ?? false)}</code></dd>
          </dl>
        </Card>
      )}

      <section className="card danger-zone">
        <header className="card-header"><h2>Опасная зона</h2></header>
        <div className="card-body danger-row">
          <div>
            <strong>Удалить воркер</strong>
            <p className="muted">Удаляет воркер со всеми версиями. Данные Durable Objects и файлы статики на диске останутся.</p>
          </div>
          <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}>
            <Icon name="trash" /> Удалить
          </button>
        </div>
      </section>

      {deleting && (
        <ConfirmDelete name={w.name} onCancel={() => setDeleting(false)}
          onConfirm={async () => {
            await api.remove(w.name);
            navigate("/");
          }} />
      )}
    </>
  );
}
