// Минимальный tar (ustar): контроллер кладёт им файлы воркера в контейнер
// (PUT /containers/<id>/archive в Docker API). Только обычные файлы и каталоги.
const BLOCK = 512;
const encoder = new TextEncoder();

/** Владелец файлов — пользователь workerd из образа движка. */
const UID = 10001;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function header(path: string, size: number, dir: boolean): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const put = (offset: number, text: string) => block.set(encoder.encode(text), offset);
  let name = path;
  let prefix = "";
  if (encoder.encode(name).length > 100) {
    const cut = path.lastIndexOf("/", 155);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
    if (cut <= 0 || encoder.encode(name).length > 100) throw new Error(`слишком длинный путь в tar: ${path}`);
  }
  put(0, name);
  put(100, octal(dir ? 0o755 : 0o644, 8));
  put(108, octal(UID, 8));
  put(116, octal(UID, 8));
  put(124, octal(size, 12));
  put(136, octal(0, 12)); // mtime
  put(148, "        "); // место под контрольную сумму
  put(156, dir ? "5" : "0");
  put(257, "ustar\0");
  put(263, "00");
  put(345, prefix);
  let sum = 0;
  for (const b of block) sum += b;
  put(148, sum.toString(8).padStart(6, "0") + "\0 ");
  return block;
}

/** files: путь → содержимое. Каталоги создаются сами. */
export function tar(files: Record<string, Uint8Array | string>): Uint8Array {
  const parts: Uint8Array[] = [];
  const dirs = new Set<string>();
  for (const [path, content] of Object.entries(files)) {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join("/") + "/";
      if (!dirs.has(dir)) {
        dirs.add(dir);
        parts.push(header(dir, 0, true));
      }
    }
    const data = typeof content === "string" ? encoder.encode(content) : content;
    parts.push(header(path, data.length, false), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(BLOCK * 2)); // конец архива
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
