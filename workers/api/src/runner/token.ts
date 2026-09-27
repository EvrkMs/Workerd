// Токен контейнера воркера: HMAC(токен платформы, "runner:<имя>").
// Им контейнер подписывает внутренние запросы к платформе (события tail, env.ASSETS):
// контейнер одного воркера не может выдать себя за другой. Меняется вместе с токеном
// платформы — тогда контейнеры пересоздаются (поколение в метке, см. orchestrator.ts).
export function runnerToken(platformToken: string, worker: string): Promise<string> {
  return hmac(platformToken, `runner:${worker}`);
}

/**
 * Токен платформы для контейнера (обратное направление): им панель подписывает
 * служебные запросы в контейнер — просмотр данных Durable Objects.
 */
export function adminToken(platformToken: string, worker: string): Promise<string> {
  return hmac(platformToken, `admin:${worker}`);
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Сравнение без утечки по времени. */
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
