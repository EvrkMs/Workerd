// Общие кусочки интерфейса: иконки, кнопки, значки, время, диалог.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { dateTime, timeAgo } from "./format";

// --- иконки (штриховые 16×16, цвет — currentColor) --------------------------------

const PATHS = {
  worker: "M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4M9 3 7 13",
  globe: "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5ZM1.75 8h12.5M8 1.75c1.7 1.8 2.5 3.9 2.5 6.25S9.7 12.45 8 14.25C6.3 12.45 5.5 10.35 5.5 8S6.3 3.55 8 1.75Z",
  search: "m13.5 13.5-3-3M11 7A4 4 0 1 1 3 7a4 4 0 0 1 8 0Z",
  refresh: "M13.25 3v3h-3M2.75 13v-3h3M12.6 6A5 5 0 0 0 3.5 5M3.4 10a5 5 0 0 0 9.1 1",
  copy: "M5.5 5.5V3.25c0-.4.35-.75.75-.75h6.5c.4 0 .75.35.75.75v6.5c0 .4-.35.75-.75.75H10.5M3.25 5.5h6.5c.4 0 .75.35.75.75v6.5c0 .4-.35.75-.75.75h-6.5a.75.75 0 0 1-.75-.75v-6.5c0-.4.35-.75.75-.75Z",
  check: "m3 8.5 3 3 7-7",
  arrow: "M3 8h10M9 4l4 4-4 4",
  external: "M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9v3.75c0 .4-.35.75-.75.75h-7.5a.75.75 0 0 1-.75-.75v-7.5c0-.4.35-.75.75-.75H7",
  chevron: "m6 4 4 4-4 4",
  dots: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  box: "M8 1.75 13.75 5v6L8 14.25 2.25 11V5L8 1.75ZM2.25 5 8 8.25 13.75 5M8 8.25v6",
  file: "M9 1.75H4.25c-.4 0-.75.35-.75.75v11c0 .4.35.75.75.75h7.5c.4 0 .75-.35.75-.75V5.25L9 1.75ZM9 1.75v3.5h3.5",
  key: "M10 6a2.5 2.5 0 1 0-4.95.5L2 9.55V12h2.45V10.5H6V9h1.5l.9-.9A2.5 2.5 0 0 0 10 6Z",
  pause: "M5.5 3.5v9M10.5 3.5v9",
  play: "M4.5 3v10l8.5-5-8.5-5Z",
  trash: "M2.5 4h11M6.5 4V2.75c0-.4.35-.75.75-.75h1.5c.4 0 .75.35.75.75V4M4 4l.6 9.1c.03.4.37.65.75.65h5.3c.38 0 .72-.25.75-.65L12 4",
  logout: "M6 13.5H3.25a.75.75 0 0 1-.75-.75v-9.5c0-.4.35-.75.75-.75H6M10.5 11l3-3-3-3M13.5 8H6",
  history: "M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5M8 5v3l2 1.5",
  link: "M6.75 9.25a2.5 2.5 0 0 0 3.55 0l2.2-2.2a2.5 2.5 0 0 0-3.55-3.55l-.6.6M9.25 6.75a2.5 2.5 0 0 0-3.55 0l-2.2 2.2a2.5 2.5 0 0 0 3.55 3.55l.6-.6",
  lock: "M4.75 7V5.25a3.25 3.25 0 0 1 6.5 0V7M3.75 7h8.5c.4 0 .75.35.75.75v5.5c0 .4-.35.75-.75.75h-8.5a.75.75 0 0 1-.75-.75v-5.5c0-.4.35-.75.75-.75Z",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d={PATHS[name]} />
    </svg>
  );
}

// --- мелкие компоненты ---------------------------------------------------------------

export function TimeAgo({ iso }: { iso: string }) {
  return <time dateTime={iso} title={dateTime(iso)}>{timeAgo(iso)}</time>;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "blue" | "green" | "amber" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function CopyButton({ text, label = "Копировать" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="btn-icon" aria-label={label} title={copied ? "Скопировано" : label}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}>
      <Icon name={copied ? "check" : "copy"} size={14} />
    </button>
  );
}

export function Card({ title, action, children, flush }: { title?: ReactNode; action?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="card">
      {title && (
        <header className="card-header">
          <h2>{title}</h2>
          {action}
        </header>
      )}
      <div className={flush ? "card-body flush" : "card-body"}>{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  return <div className="note note-error">{error instanceof Error ? error.message : String(error)}</div>;
}

// --- меню «⋯» ---------------------------------------------------------------------------

export function Menu({ items }: { items: { label: string; icon?: IconName; danger?: boolean; onSelect: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="btn-icon" aria-label="Действия" aria-haspopup="menu" aria-expanded={open}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(!open); }}>
        <Icon name="dots" size={18} />
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitem" className={item.danger ? "danger" : ""}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); item.onSelect(); }}>
              {item.icon && <Icon name={item.icon} size={14} />}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- подтверждение удаления: нужно ввести имя ----------------------------------------------

export function ConfirmDelete({ name, title = "Удалить воркер?", children, onCancel, onConfirm }: {
  /** Что нужно ввести для подтверждения. */
  name: string;
  title?: string;
  /** Описание последствий; по умолчанию — про удаление воркера. */
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="confirm-title">{title}</h2>
        <p className="muted">
          {children ?? <>
            Воркер <code>{name}</code> будет удалён со всеми версиями, его адрес перестанет отвечать.
            Данные Durable Objects на диске останутся — их можно удалить в разделе «Durable Objects».
          </>}
        </p>
        <label className="field">
          <span>Введите <code>{name}</code> для подтверждения</span>
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} />
        </label>
        {error != null && <ErrorNote error={error} />}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>Отмена</button>
          <button type="button" className="btn btn-danger" disabled={typed !== name || busy}
            onClick={async () => {
              setBusy(true);
              try { await onConfirm(); } catch (e) { setError(e); setBusy(false); }
            }}>
            {busy ? "Удаление…" : "Удалить"}
          </button>
        </div>
      </div>
    </div>
  );
}
