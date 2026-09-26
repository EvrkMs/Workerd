// Модуль-прослойка, который платформа подмешивает в каждый загруженный воркер
// главным модулем (__platform.js). Он реэкспортирует всё из кода пользователя, но
// оборачивает env: служебные биндинги __DO_<ИМЯ> превращаются в env.<ИМЯ> с API
// как у DurableObjectNamespace в Cloudflare (синхронные idFromName/get/getByName).
//
// Stub объекта — JS Proxy: stub.method(...args) → RPC call() в платформу,
// stub.fetch(...) → fetchObject(). Сам объект живёт в Host-DO платформы как facet.

export const PLATFORM_MODULE = "__platform.js";

export function shimModule(mainModule: string, doClasses: string[]): string {
  const main = JSON.stringify(`./${mainModule}`);
  const classWrappers = doClasses
    .map(
      (cls) => `
export class ${cls} extends (user.${cls} ?? missingClass(${JSON.stringify(cls)})) {
  constructor(ctx, env) { super(ctx, wrapEnv(env)); }
}`,
    )
    .join("\n");

  return `
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

const toHex = (s) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");

class DurableObjectNamespace {
  #raw;
  constructor(raw) { this.#raw = raw; }
  idFromName(name) { return new DurableObjectId(toHex("n:" + name), name); }
  newUniqueId() { return new DurableObjectId(toHex("u:" + crypto.randomUUID())); }
  idFromString(hex) {
    if (!/^[0-9a-f]+$/.test(hex)) throw new TypeError("Invalid Durable Object ID");
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
        if (prop === "fetch") return (input, init) => raw.fetchObject(hex, new Request(input, init));
        return (...args) => raw.call(hex, prop, args);
      },
    });
  }
}

const wrapped = new WeakMap();
function wrapEnv(env) {
  if (!env || typeof env !== "object") return env;
  let out = wrapped.get(env);
  if (out) return out;
  out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("__DO_")) out[key.slice(5)] = new DurableObjectNamespace(value);
    else out[key] = value;
  }
  wrapped.set(env, out);
  return out;
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
