const relative = new Intl.RelativeTimeFormat("ru", { numeric: "auto", style: "short" });
const absolute = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" });

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** «5 мин. назад», «вчера», «3 мес. назад». */
export function timeAgo(iso: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, size] of STEPS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "только что";
}

export function dateTime(iso: string | number): string {
  return absolute.format(new Date(iso));
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Номер версии в виде короткого id, как в дашбордах: v26 → «0000001a». */
export function versionId(id: number): string {
  return id.toString(16).padStart(8, "0");
}
