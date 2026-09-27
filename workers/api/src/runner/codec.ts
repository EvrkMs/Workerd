// Кодек RPC между воркерами платформы (исходник для прослойки __platform.js).
// Воркеры в разных процессах, поэтому аргументы и результаты идут по HTTP в JSON.
// Кодек сохраняет типы, которые JSON теряет: undefined, NaN/±Infinity/-0, BigInt, Date,
// RegExp, Map, Set, ArrayBuffer и typed arrays, Error. Функции, стабы, потоки и
// объекты классов передать нельзя — кодек сразу бросает понятную ошибку.
//
// Особые значения кодируются как {"$t": тип, ...}; обычный объект с ключом "$t"
// оборачивается, чтобы его нельзя было спутать с особым значением.
export const CODEC_SOURCE = `
const TYPED = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(text) {
  const s = atob(text);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

function rpcEncode(value, seen = new Set()) {
  switch (typeof value) {
    case "undefined": return { $t: "undefined" };
    case "boolean": case "string": return value;
    case "number":
      if (Number.isNaN(value) || !Number.isFinite(value) || Object.is(value, -0)) return { $t: "number", v: String(value === 0 ? "-0" : value) };
      return value;
    case "bigint": return { $t: "bigint", v: value.toString() };
    case "function": throw new TypeError("функцию нельзя передать через RPC между воркерами платформы");
    case "symbol": throw new TypeError("Symbol нельзя передать через RPC");
  }
  if (value === null) return null;
  if (seen.has(value)) throw new TypeError("циклические ссылки через RPC не передаются");
  seen.add(value);
  try {
    if (Array.isArray(value)) return Array.from(value, (v) => rpcEncode(v, seen));
    if (value instanceof Date) return { $t: "Date", v: value.getTime() };
    if (value instanceof RegExp) return { $t: "RegExp", v: [value.source, value.flags] };
    if (value instanceof Map) return { $t: "Map", v: [...value].map(([k, v]) => [rpcEncode(k, seen), rpcEncode(v, seen)]) };
    if (value instanceof Set) return { $t: "Set", v: [...value].map((v) => rpcEncode(v, seen)) };
    if (value instanceof ArrayBuffer) return { $t: "ArrayBuffer", v: toBase64(new Uint8Array(value)) };
    if (ArrayBuffer.isView(value)) {
      const kind = Object.keys(TYPED).find((k) => value instanceof TYPED[k]) ?? "Uint8Array";
      return { $t: kind, v: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    }
    if (value instanceof Error) return { $t: "Error", name: value.name, message: value.message };
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const name = value?.constructor?.name ?? "объект";
      throw new TypeError(name + " нельзя передать через RPC между воркерами платформы (только данные: объекты, массивы, Date, Map, Set, бинарные данные)");
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rpcEncode(v, seen);
    return "$t" in value ? { $t: "Object", v: out } : out;
  } finally {
    seen.delete(value);
  }
}

function rpcDecode(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(rpcDecode);
  if (typeof value.$t !== "string") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rpcDecode(v);
    return out;
  }
  switch (value.$t) {
    case "undefined": return undefined;
    case "number": return value.v === "-0" ? -0 : Number(value.v);
    case "bigint": return BigInt(value.v);
    case "Date": return new Date(value.v);
    case "RegExp": return new RegExp(value.v[0], value.v[1]);
    case "Map": return new Map(value.v.map(([k, v]) => [rpcDecode(k), rpcDecode(v)]));
    case "Set": return new Set(value.v.map(rpcDecode));
    case "ArrayBuffer": return fromBase64(value.v).buffer;
    case "Error": {
      const error = new Error(value.message);
      error.name = value.name;
      return error;
    }
    case "Object": {
      const out = {};
      for (const [k, v] of Object.entries(value.v)) out[k] = rpcDecode(v);
      return out;
    }
    default: {
      const Typed = TYPED[value.$t];
      if (!Typed) throw new TypeError("неизвестный тип в RPC: " + value.$t);
      const bytes = fromBase64(value.v);
      if (Typed === DataView) return new DataView(bytes.buffer);
      return new Typed(bytes.buffer, 0, bytes.byteLength / Typed.BYTES_PER_ELEMENT);
    }
  }
}

// Короткое читаемое представление значения — для просмотра данных DO в панели
function preview(value, limit = 2000) {
  const seen = new WeakSet();
  let text;
  try {
    text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value, (key, v) => {
      if (typeof v === "bigint") return v.toString() + "n";
      if (v === undefined) return "undefined";
      if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), x]));
      if (v instanceof Set) return [...v];
      if (v instanceof ArrayBuffer) return "<" + v.byteLength + " байт>";
      if (ArrayBuffer.isView(v)) return "<" + v.constructor.name + ", " + v.byteLength + " байт>";
      if (v && typeof v === "object") {
        if (seen.has(v)) return "<цикл>";
        seen.add(v);
      }
      return v;
    });
  } catch (e) {
    text = "<" + (e?.message ?? "не удалось показать") + ">";
  }
  if (text === undefined) text = String(value);
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}
`;
