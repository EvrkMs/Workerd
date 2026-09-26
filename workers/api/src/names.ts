// Имя воркера = поддомен <имя>.workers.ava-kk.ru, поэтому правила — как у DNS-метки.
const WORKER_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Поддомены, которые заняты самой платформой. */
export const RESERVED_NAMES = new Set(["api", "panel", "www"]);

export function isValidWorkerName(name: string): boolean {
  return WORKER_NAME.test(name);
}
