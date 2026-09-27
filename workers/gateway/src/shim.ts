// Модуль-прослойка, который платформа подмешивает в каждый загруженный воркер
// главным модулем (__platform.js). Он реэкспортирует всё из кода пользователя, но
// оборачивает env: служебные биндинги __DO_<ИМЯ> превращаются в env.<ИМЯ> с API
// как у DurableObjectNamespace в Cloudflare (синхронные idFromName/get/getByName).
//
// Stub объекта — JS Proxy: stub.method(...args) → RPC call() в платформу,
// stub.fetch(...) → fetch-обработчик биндинга (так проходит и WebSocket). Сам объект живёт в Host-DO платформы как facet.
//
// Service bindings (__SVC_<ИМЯ>) — такой же Proxy. На стороне вызываемого воркера вызов
// приходит в __PlatformEntry: он создаёт нужный entrypoint (default или именованный)
// с обёрнутым env и вызывает метод — так env обёрнут и у именованных entrypoint'ов.

export const PLATFORM_MODULE = "__platform.js";
/** Вход для service bindings (экспорт прослойки). */
export const PLATFORM_ENTRY = "__PlatformEntry";

export function shimModule(mainModule: string, doClasses: string[]): string {
  const main = JSON.stringify(`./${mainModule}`);
  const classWrappers = doClasses
    .map(
      (cls) => `
export class ${cls} extends (user.${cls} ?? missingClass(${JSON.stringify(cls)})) {
  constructor(ctx, env) { patchAlarms(ctx, env); super(ctx, wrapEnv(env)); }
  __platformAlarm(info) { return typeof this.alarm === "function" ? this.alarm(info) : undefined; }
}`,
    )
    .join("\n");

  return `
import { WorkerEntrypoint } from "cloudflare:workers";
import * as user from ${main};
export * from ${main};

function missingClass(name) {
  throw new Error("класс Durable Object " + name + " не экспортирован из главного модуля");
}

class DurableObjectId {
  constructor(hex, name) { this.hex = hex; if (name !== undefined) this.name = name; }
  toString() { return this.hex; }
  equals(other) { return !!other && other.toString() === this.hex; }
}

// id объекта — SHA-256 (64 hex), как в Cloudflare: по id нельзя восстановить имя.
// idFromName синхронный, а crypto.subtle — нет, поэтому своя компактная реализация.
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
function sha256hex(text) {
  const data = new TextEncoder().encode(text);
  const length = ((data.length + 9 + 63) >> 6) << 6;
  const bytes = new Uint8Array(length);
  bytes.set(data);
  bytes[data.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(length - 4, data.length * 8);
  view.setUint32(length - 8, Math.floor(data.length / 0x20000000));
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

const OBJECT_ID = /^[0-9a-f]{64}$/;

class DurableObjectNamespace {
  #raw;
  constructor(raw) { this.#raw = raw; }
  idFromName(name) { return new DurableObjectId(sha256hex("n:" + name), name); }
  newUniqueId() { return new DurableObjectId(sha256hex("u:" + crypto.randomUUID())); }
  idFromString(hex) {
    if (!OBJECT_ID.test(hex)) throw new TypeError("Invalid Durable Object ID");
    return new DurableObjectId(hex);
  }
  jurisdiction() { return this; }
  getByName(name) { return this.get(this.idFromName(name)); }
  get(id) {
    const raw = this.#raw;
    const hex = id.toString();
    return new Proxy({ id, name: id.name }, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop !== "string" || prop === "then") return undefined; // stub не thenable
        if (prop === "fetch") return (input, init) => {
          // через fetch, а не RPC: так проходит и WebSocket (Response с webSocket)
          const request = new Request(input, init);
          const headers = new Headers(request.headers);
          headers.set("x-platform-object", hex);
          return raw.fetch(new Request(request, { headers }));
        };
        return (...args) => raw.call(hex, prop, args);
      },
    });
  }
}

// facet сам ставить будильники не может — ведём их через Host (env.__ALARMS, id объекта = id Host)
function patchAlarms(ctx, env) {
  const alarms = env && env.__ALARMS;
  if (!alarms) return;
  const host = ctx.id.toString();
  const storage = ctx.storage;
  storage.setAlarm = (time) => alarms.set(host, time instanceof Date ? time.getTime() : Number(time));
  storage.getAlarm = () => alarms.get(host);
  storage.deleteAlarm = () => alarms.delete(host);
}

// env.<ИМЯ> другого воркера: fetch() — HTTP, любой другой метод — RPC
function serviceStub(raw) {
  return new Proxy({}, {
    get(_, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined; // не thenable
      if (prop === "fetch") return (input, init) => raw.fetch(input, init);
      return (...args) => raw.call(prop, args);
    },
  });
}

const wrapped = new WeakMap();
function wrapEnv(env) {
  if (!env || typeof env !== "object") return env;
  let out = wrapped.get(env);
  if (out) return out;
  out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("__DO_")) out[key.slice(5)] = new DurableObjectNamespace(value);
    else if (key.startsWith("__SVC_")) out[key.slice(6)] = serviceStub(value);
    else if (key !== "__ALARMS") out[key] = value;
  }
  wrapped.set(env, out);
  return out;
}

// Вход для service bindings: props.entrypoint — имя класса WorkerEntrypoint или null (default)
const FORBIDDEN = new Set(["constructor", "fetch", "connect", "tail", "trace", "scheduled", "queue", "email", "test", "alarm"]);
export class ${PLATFORM_ENTRY} extends WorkerEntrypoint {
  #target() {
    const name = this.ctx.props?.entrypoint ?? null;
    const exported = name === null ? user.default : user[name];
    if (typeof exported === "function") return { instance: new exported(this.ctx, wrapEnv(this.env)), handler: false };
    if (name === null && exported && typeof exported === "object") return { instance: exported, handler: true };
    throw new Error(name === null
      ? "у воркера нет default-экспорта"
      : "entrypoint " + name + " не экспортирован из главного модуля");
  }
  fetch(request) {
    const { instance, handler } = this.#target();
    if (typeof instance.fetch !== "function") throw new Error("у entrypoint нет fetch()");
    return handler ? instance.fetch(request, wrapEnv(this.env), this.ctx) : instance.fetch(request);
  }
  call(method, args) {
    const { instance, handler } = this.#target();
    if (handler) throw new Error("RPC доступен только у класса WorkerEntrypoint (export default class extends WorkerEntrypoint)");
    if (typeof method !== "string" || method.startsWith("__") || FORBIDDEN.has(method) || method in Object.prototype
        || typeof instance[method] !== "function") {
      throw new TypeError("метод " + method + " не найден у entrypoint");
    }
    return instance[method](...args);
  }
}

const original = user.default;
let wrappedDefault;
if (typeof original === "function") {
  // class extends WorkerEntrypoint
  wrappedDefault = class extends original { constructor(ctx, env) { super(ctx, wrapEnv(env)); } };
} else if (original && typeof original === "object") {
  // { fetch(request, env, ctx), scheduled(...), ... }
  wrappedDefault = {};
  for (const [key, value] of Object.entries(original)) {
    wrappedDefault[key] = typeof value === "function"
      ? (arg, env, ctx) => value.call(original, arg, wrapEnv(env), ctx)
      : value;
  }
}
export default wrappedDefault;
${classWrappers}
`;
}
