// Живые логи воркера — тот же TailHub, что у `wravler tail` (протокол trace-v1).
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Empty, ErrorNote, Icon } from "../ui";

interface TraceEvent {
  outcome: string;
  eventTimestamp: number;
  event?: { request?: { method: string; url: string }; response?: { status: number } } | null;
  logs: { level: string; message: unknown[]; timestamp: number }[];
  exceptions: { name: string; message: string; stack?: string }[];
}

type Status = "connecting" | "live" | "paused" | "closed";

const MAX_EVENTS = 300;

export function Logs({ name }: { name: string }) {
  const [events, setEvents] = useState<(TraceEvent & { key: number })[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState<unknown>(null);
  const paused = useRef(false);
  const counter = useRef(0);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let sessionId: string | null = null;
    let closed = false;

    api.startTail(name)
      .then(({ id, url }) => {
        sessionId = id;
        if (closed) return;
        socket = new WebSocket(url, "trace-v1");
        socket.onopen = () => {
          socket?.send(JSON.stringify({ debug: false }));
          setStatus(paused.current ? "paused" : "live");
        };
        socket.onmessage = async (message) => {
          if (paused.current) return;
          const text = typeof message.data === "string" ? message.data : await (message.data as Blob).text();
          const event = JSON.parse(text) as TraceEvent;
          setEvents((list) => [{ ...event, key: counter.current++ }, ...list].slice(0, MAX_EVENTS));
        };
        socket.onclose = () => !closed && setStatus("closed");
        socket.onerror = () => setError(new Error("Соединение с логами прервалось"));
      })
      .catch((e) => {
        setError(e);
        setStatus("closed");
      });

    return () => {
      closed = true;
      socket?.close(1000, "panel closed");
      if (sessionId) api.stopTail(name, sessionId).catch(() => {});
    };
  }, [name]);

  return (
    <>
      <div className="toolbar logs-toolbar">
        <span className={`live-dot ${status}`} aria-hidden="true" />
        <span>{STATUS_TEXT[status]}</span>
        <span className="grow" />
        <button type="button" className="btn btn-small" disabled={status === "closed" || status === "connecting"}
          onClick={() => {
            paused.current = !paused.current;
            setStatus(paused.current ? "paused" : "live");
          }}>
          <Icon name={status === "paused" ? "play" : "pause"} size={14} />
          {status === "paused" ? "Продолжить" : "Пауза"}
        </button>
        <button type="button" className="btn btn-small" onClick={() => setEvents([])} disabled={events.length === 0}>
          Очистить
        </button>
      </div>
      {error != null && <ErrorNote error={error} />}
      {events.length === 0 ? (
        <Empty>
          {status === "closed"
            ? "Сессия логов закрыта — обнови страницу, чтобы подключиться снова"
            : "Ждём запросы к воркеру… Открой его адрес, и события появятся здесь."}
        </Empty>
      ) : (
        <ol className="log-list">
          {events.map((e) => <LogEntry key={e.key} event={e} />)}
        </ol>
      )}
    </>
  );
}

const STATUS_TEXT: Record<Status, string> = {
  connecting: "Подключение…",
  live: "В реальном времени",
  paused: "На паузе — новые события не показываются",
  closed: "Отключено",
};

function LogEntry({ event: e }: { event: TraceEvent }) {
  const request = e.event?.request;
  const status = e.event?.response?.status;
  const path = request ? new URL(request.url).pathname + new URL(request.url).search : "—";
  const failed = e.outcome !== "ok" || e.exceptions.length > 0 || (status ?? 0) >= 500;
  const time = new Date(e.eventTimestamp).toLocaleTimeString("ru-RU", { hour12: false });

  return (
    <li className={failed ? "log failed" : "log"}>
      <div className="log-head">
        <span className="log-time">{time}</span>
        <span className="log-method">{request?.method ?? "?"}</span>
        <span className="log-path" title={request?.url}>{path}</span>
        <span className={`log-status ${failed ? "bad" : "good"}`}>{status ?? e.outcome}</span>
      </div>
      {(e.logs.length > 0 || e.exceptions.length > 0) && (
        <div className="log-body">
          {e.logs.map((l, i) => (
            <div key={i} className={`log-line level-${l.level}`}>
              <span className="log-level">{l.level}</span>
              <span>{l.message.map(format).join(" ")}</span>
            </div>
          ))}
          {e.exceptions.map((x, i) => (
            <div key={`x${i}`} className="log-line level-error">
              <span className="log-level">{x.name}</span>
              <span>{x.message}{x.stack && <pre>{x.stack}</pre>}</span>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function format(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
