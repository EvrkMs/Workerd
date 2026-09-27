import { useMemo, useState } from "react";
import { api, type WorkerSummary } from "../api";
import { plural } from "../format";
import { href, linkProps, navigate } from "../router";
import { useAsync } from "../useAsync";
import { Badge, ConfirmDelete, Empty, ErrorNote, Icon, Menu, TimeAgo } from "../ui";

type Sort = "updated" | "name";

export function WorkersList({ rootDomain }: { rootDomain: string }) {
  const { data, error, loading, reload } = useAsync(api.workers, []);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("updated");
  const [deleting, setDeleting] = useState<string | null>(null);

  const workers = useMemo(() => {
    const list = (data ?? []).filter((w) => w.name.includes(query.trim().toLowerCase()));
    return list.sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt),
    );
  }, [data, query, sort]);

  return (
    <main className="page">
      <header className="page-header">
        <div>
          <h1>Воркеры</h1>
          <p className="muted">
            Деплой — <code>wravler deploy</code>, каждый воркер доступен на <code>&lt;имя&gt;.{rootDomain}</code>
          </p>
        </div>
      </header>

      <div className="toolbar">
        <label className="toolbar-search">
          <Icon name="search" />
          <input placeholder="Поиск по имени" aria-label="Поиск по имени" value={query}
            onChange={(e) => setQuery(e.target.value)} />
        </label>
        <select aria-label="Сортировка" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="updated">Сначала новые</option>
          <option value="name">По имени</option>
        </select>
        <button type="button" className="btn-icon toolbar-button" aria-label="Обновить" title="Обновить" onClick={reload}>
          <Icon name="refresh" />
        </button>
      </div>

      {error != null && <ErrorNote error={error} />}
      {loading && !data && <div className="skeleton-list">{[0, 1, 2].map((i) => <div key={i} className="skeleton" />)}</div>}
      {data && workers.length === 0 && (
        <Empty>{query ? "Ничего не найдено" : <>Воркеров пока нет. Задеплой первый: <code>wravler deploy</code></>}</Empty>
      )}

      <ul className="worker-list">
        {workers.map((w) => (
          <WorkerRow key={w.name} worker={w} rootDomain={rootDomain} onDelete={() => setDeleting(w.name)} />
        ))}
      </ul>

      {data && workers.length > 0 && (
        <p className="muted small">
          {workers.length} {plural(workers.length, "воркер", "воркера", "воркеров")}
          {query && ` из ${data.length}`}
        </p>
      )}

      {deleting && (
        <ConfirmDelete name={deleting} onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await api.remove(deleting);
            setDeleting(null);
            reload();
          }} />
      )}
    </main>
  );
}

function WorkerRow({ worker: w, rootDomain, onDelete }: { worker: WorkerSummary; rootDomain: string; onDelete: () => void }) {
  const url = `https://${w.name}.${rootDomain}`;
  const page = href({ page: "worker", name: w.name, tab: "overview" });
  return (
    <li className="worker-card">
      <a className="worker-card-link" aria-label={w.name} {...linkProps(page)} />
      <div className="worker-card-main">
        <span className="worker-icon"><Icon name="worker" size={18} /></span>
        <div className="worker-card-title">
          <span className="worker-name">{w.name}</span>
          {w.public
            ? <a className="worker-url" href={url} target="_blank" rel="noreferrer">{url.replace("https://", "")}</a>
            : <span className="worker-url muted">только для других воркеров</span>}
        </div>
        <div className="worker-badges">
          {!w.public && <Badge>Закрытый</Badge>}
          {w.services > 0 && <Badge tone="blue">Воркеры</Badge>}
          {w.durableObjects > 0 && <Badge tone="blue">Durable Objects</Badge>}
          {w.assetFiles > 0 && <Badge tone="green">Статика</Badge>}
          {!w.hasCode && <Badge>Без кода</Badge>}
        </div>
        <span className="muted nowrap"><TimeAgo iso={w.updatedAt} /></span>
        <Menu items={[
          ...(w.public
            ? [{ label: "Открыть сайт", icon: "external" as const, onSelect: () => window.open(url, "_blank", "noreferrer") }]
            : []),
          { label: "Версии", icon: "history", onSelect: () => navigate(href({ page: "worker", name: w.name, tab: "versions" })) },
          { label: "Логи", icon: "file", onSelect: () => navigate(href({ page: "worker", name: w.name, tab: "logs" })) },
          { label: "Удалить", icon: "trash", danger: true, onSelect: onDelete },
        ]} />
      </div>
      <div className="worker-card-footer">
        <a className="subtle-link" {...linkProps(href({ page: "worker", name: w.name, tab: "versions" }))}>
          Версии <Icon name="arrow" size={12} />
        </a>
        <span className="muted">
          активна v{w.version} · {w.versions} {plural(w.versions, "версия", "версии", "версий")}
        </span>
      </div>
    </li>
  );
}
