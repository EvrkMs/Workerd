// Раздел «Durable Objects»: все классы с данными на диске, отдельно от воркеров —
// в том числе «осиротевшие» (воркер удалён, класс больше не используется).
import { useState } from "react";
import { api, type NamespaceSummary } from "../api";
import { bytes, plural } from "../format";
import { href, linkProps, navigate } from "../router";
import { useAsync } from "../useAsync";
import { Badge, Card, ConfirmDelete, Empty, ErrorNote, Icon, Menu, TimeAgo } from "../ui";

export function StatusBadge({ status }: { status: NamespaceSummary["status"] }) {
  if (status === "active") return <Badge tone="green">Используется</Badge>;
  if (status === "worker-deleted") return <Badge tone="amber">Воркер удалён</Badge>;
  return <Badge tone="amber">Класс не используется</Badge>;
}

export function DurableObjects() {
  const { data, error, loading, reload } = useAsync(api.durableObjects, []);
  const [deleting, setDeleting] = useState<NamespaceSummary | null>(null);
  const [deletingLegacy, setDeletingLegacy] = useState(false);
  const namespaces = data?.namespaces ?? [];

  return (
    <main className="page">
      <header className="page-header">
        <div>
          <h1>Durable Objects</h1>
          <p className="muted">
            Классы с данными на диске. Данные не удаляются вместе с воркером — их удаляют здесь.
          </p>
        </div>
        <button type="button" className="btn-icon" aria-label="Обновить" title="Обновить" onClick={reload}>
          <Icon name="refresh" />
        </button>
      </header>

      {error != null && <ErrorNote error={error} />}
      {loading && !data && <div className="skeleton" />}

      {data && (
        <Card flush>
          {namespaces.length === 0 ? <Empty>Данных Durable Objects нет</Empty> : (
            <table className="table">
              <thead>
                <tr>
                  <th>Класс</th>
                  <th className="hide-sm">Воркер</th>
                  <th className="num">Объекты</th>
                  <th className="num hide-sm">Размер</th>
                  <th className="hide-sm">Изменён</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {namespaces.map((ns) => {
                  const page = href({ page: "namespace", worker: ns.worker, className: ns.className });
                  const workerLink = linkProps(href({ page: "worker", name: ns.worker, tab: "overview" }));
                  return (
                    <tr key={`${ns.worker}/${ns.className}`} className="row-link" onClick={() => navigate(page)}>
                      <td>
                        <span className="cell-icon">
                          <Icon name="box" size={14} />
                          <a {...linkProps(page)}><code>{ns.className}</code></a>
                        </span>
                        <div className="row-sub"><StatusBadge status={ns.status} /></div>
                      </td>
                      <td className="hide-sm">
                        {ns.status === "worker-deleted"
                          ? <span className="muted">{ns.worker}</span>
                          : <a href={workerLink.href} onClick={(e) => { e.stopPropagation(); workerLink.onClick(e); }}>{ns.worker}</a>}
                      </td>
                      <td className="num">{ns.objects}</td>
                      <td className="num hide-sm">{bytes(ns.size)}</td>
                      <td className="muted nowrap hide-sm">{ns.modified ? <TimeAgo iso={ns.modified} /> : "—"}</td>
                      <td className="cell-menu" onClick={(e) => e.stopPropagation()}>
                        <Menu items={[
                          { label: "Объекты", icon: "box", onSelect: () => navigate(page) },
                          { label: "Удалить данные", icon: "trash", danger: true, onSelect: () => setDeleting(ns) },
                        ]} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {data?.legacy && (
        <Card title="Старые данные (до перехода на контейнеры)" action={
          <button type="button" className="btn btn-small btn-danger" onClick={() => setDeletingLegacy(true)}>
            <Icon name="trash" size={14} /> Удалить
          </button>
        }>
          <p className="muted">
            Durable Objects времён Worker Loader, <code>/data/platform-Host</code>: {data.legacy.files}{" "}
            {plural(data.legacy.files, "файл", "файла", "файлов")}, {bytes(data.legacy.size)}. Текущие воркеры их не
            используют: id объектов в новой схеме считаются иначе. Копия есть в бэкапах.
          </p>
        </Card>
      )}

      {deleting && (
        <ConfirmDelete name={deleting.className} title="Удалить данные класса?" onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteNamespace(deleting.worker, deleting.className);
            setDeleting(null);
            reload();
          }}>
          Все объекты <code>{deleting.className}</code> воркера <code>{deleting.worker}</code> ({deleting.objects}{" "}
          {plural(deleting.objects, "объект", "объекта", "объектов")}, {bytes(deleting.size)}) будут удалены безвозвратно.
          {deleting.status === "active" && " Воркер на несколько секунд перезапустится."}
        </ConfirmDelete>
      )}
      {deletingLegacy && (
        <ConfirmDelete name="platform-Host" title="Удалить старые данные?" onCancel={() => setDeletingLegacy(false)}
          onConfirm={async () => {
            await api.deleteLegacy();
            setDeletingLegacy(false);
            reload();
          }}>
          Каталог <code>/data/platform-Host</code> будет удалён безвозвратно (в бэкапах копия останется).
        </ConfirmDelete>
      )}
    </main>
  );
}
