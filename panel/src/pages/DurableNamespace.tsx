// Класс Durable Object: объекты на диске, данные выбранного объекта, удаление.
import { useState } from "react";
import { api, type ObjectSummary } from "../api";
import { bytes, dateTime, plural } from "../format";
import { href, linkProps, navigate } from "../router";
import { useAsync } from "../useAsync";
import { Card, ConfirmDelete, CopyButton, Empty, ErrorNote, Icon, TimeAgo } from "../ui";
import { StatusBadge } from "./DurableObjects";

export function DurableNamespace({ worker, className }: { worker: string; className: string }) {
  const summary = useAsync(api.durableObjects, []);
  const objects = useAsync(() => api.objects(worker, className), [worker, className]);
  const [selected, setSelected] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ObjectSummary | "all" | null>(null);

  const ns = summary.data?.namespaces.find((n) => n.worker === worker && n.className === className);
  const list = objects.data ?? [];
  const reload = () => {
    summary.reload();
    objects.reload();
  };

  return (
    <main className="page">
      <header className="page-header">
        <div>
          <h1><code>{className}</code></h1>
          <p className="muted">
            Воркер{" "}
            {ns?.status === "worker-deleted"
              ? <code>{worker}</code>
              : <a {...linkProps(href({ page: "worker", name: worker, tab: "overview" }))}><code>{worker}</code></a>}
            {ns?.binding && <> · биндинг <code>{ns.binding}</code></>}
          </p>
        </div>
        <div className="header-actions">
          {ns && <StatusBadge status={ns.status} />}
          <button type="button" className="btn btn-danger" disabled={!list.length} onClick={() => setDeleting("all")}>
            <Icon name="trash" size={14} /> <span className="hide-sm">Удалить все данные</span>
          </button>
        </div>
      </header>

      {ns && ns.status !== "active" && (
        <div className="note note-warning">
          {ns.status === "worker-deleted"
            ? "Воркер удалён. Если задеплоить его снова с этим классом, он найдёт эти данные."
            : "Активная версия воркера этот класс не использует. Данные можно удалить; посмотреть их — только когда класс снова в коде."}
        </div>
      )}

      {objects.error != null && <ErrorNote error={objects.error} />}
      {objects.loading && !objects.data && <div className="skeleton" />}

      {objects.data && (
        <Card title={`${list.length} ${plural(list.length, "объект", "объекта", "объектов")}${ns ? ` · ${bytes(ns.size)}` : ""}`} flush
          action={
            <button type="button" className="btn-icon" aria-label="Обновить" title="Обновить" onClick={reload}>
              <Icon name="refresh" size={14} />
            </button>
          }>
          {list.length === 0 ? <Empty>Объектов нет</Empty> : (
            <table className="table">
              <thead>
                <tr><th>ID</th><th className="num">Размер</th><th className="hide-sm">Изменён</th><th /></tr>
              </thead>
              <tbody>
                {list.map((o) => (
                  <tr key={o.id} className={o.id === selected ? "row-link selected" : "row-link"}
                    onClick={() => setSelected(o.id === selected ? null : o.id)}>
                    <td className="truncate-cell">
                      <span className="cell-icon"><code className="truncate" title={o.id}>{o.id}</code></span>
                    </td>
                    <td className="num nowrap">{bytes(o.size)}</td>
                    <td className="muted nowrap hide-sm">{o.modified ? <TimeAgo iso={o.modified} /> : "—"}</td>
                    <td className="cell-menu nowrap" onClick={(e) => e.stopPropagation()}>
                      <CopyButton text={o.id} label="Копировать ID" />
                      <button type="button" className="btn-icon" aria-label="Удалить объект" title="Удалить объект"
                        onClick={() => setDeleting(o)}>
                        <Icon name="trash" size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {selected && <ObjectView worker={worker} className={className} id={selected} canInspect={ns?.status === "active"} />}

      {deleting && (
        <ConfirmDelete
          name={deleting === "all" ? className : deleting.id.slice(0, 8)}
          title={deleting === "all" ? "Удалить все данные класса?" : "Удалить объект?"}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            if (deleting === "all") {
              await api.deleteNamespace(worker, className);
              setDeleting(null);
              navigate(href({ page: "durable-objects" }));
              return;
            }
            await api.deleteObject(worker, className, deleting.id);
            if (selected === deleting.id) setSelected(null);
            setDeleting(null);
            reload();
          }}>
          {deleting === "all"
            ? <>Все объекты <code>{className}</code> ({list.length}) будут удалены безвозвратно.</>
            : <>Объект <code>{deleting.id.slice(0, 16)}…</code> будет удалён со всеми данными и будильником.
                Если к нему снова обратятся, он создастся пустым.</>}
          {ns?.status === "active" && " Воркер на несколько секунд перезапустится."}
          {deleting !== "all" && <> Для подтверждения — первые 8 символов ID.</>}
        </ConfirmDelete>
      )}
    </main>
  );
}

function ObjectView({ worker, className, id, canInspect }: { worker: string; className: string; id: string; canInspect: boolean }) {
  const data = useAsync(() => (canInspect ? api.object(worker, className, id) : Promise.resolve(null)), [worker, className, id, canInspect]);

  return (
    <Card title={<>Объект <code>{id.slice(0, 12)}…</code></>} action={
      canInspect && (
        <button type="button" className="btn-icon" aria-label="Обновить" title="Обновить" onClick={data.reload}>
          <Icon name="refresh" size={14} />
        </button>
      )
    }>
      {!canInspect && <p className="muted">Посмотреть данные можно, только когда класс используется активной версией воркера.</p>}
      {data.error != null && <ErrorNote error={data.error} />}
      {canInspect && data.loading && !data.data && <div className="skeleton" />}
      {data.data && (
        <div className="object-data">
          <dl className="fields">
            <dt>Будильник</dt>
            <dd>{data.data.alarm ? dateTime(data.data.alarm) : <span className="muted">нет</span>}</dd>
          </dl>

          <h3>KV-хранилище <span className="muted">· {data.data.kvTotal}</span></h3>
          {data.data.kv.length === 0 ? <p className="muted">Пусто</p> : (
            <div className="table-scroll">
              <table className="table data-table">
                <thead><tr><th>Ключ</th><th>Значение</th></tr></thead>
                <tbody>
                  {data.data.kv.map((e) => (
                    <tr key={e.key}><td><code>{e.key}</code></td><td><code className="value">{e.value}</code></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.data.kvTotal > data.data.kv.length && <p className="muted small">Показаны первые {data.data.kv.length}.</p>}

          {data.data.tables.map((t) => (
            <section key={t.name}>
              <h3>Таблица <code>{t.name}</code> <span className="muted">· {t.total} {plural(t.total, "строка", "строки", "строк")}</span></h3>
              {t.rows.length === 0 ? <p className="muted">Пусто</p> : (
                <div className="table-scroll">
                  <table className="table data-table">
                    <thead><tr>{t.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                    <tbody>
                      {t.rows.map((row, i) => (
                        <tr key={i}>{row.map((v, j) => <td key={j}><code className="value">{v}</code></td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {t.total > t.rows.length && <p className="muted small">Показаны первые {t.rows.length}.</p>}
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
