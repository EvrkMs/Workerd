import { useState } from "react";
import { api } from "../api";
import { ErrorNote } from "../ui";

export function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  return (
    <main className="login">
      <form
        className="card login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.login(token);
            onDone();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="login-logo" aria-hidden="true">
          <img src="/favicon.svg" alt="" width={36} height={36} />
        </div>
        <h1>Воркеры</h1>
        <p className="muted">
          Токен платформы — тот же, что у wravler: <code>~/.config/wravler/token</code>
        </p>
        <label className="field">
          <span>Токен</span>
          <input type="password" autoComplete="current-password" autoFocus required value={token}
            onChange={(e) => setToken(e.target.value)} />
        </label>
        {error != null && <ErrorNote error={error} />}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !token}>
          {busy ? "Вход…" : "Войти"}
        </button>
      </form>
    </main>
  );
}
