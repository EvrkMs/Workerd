using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "gateway", worker = .gatewayWorker),
    (name = "hello", worker = .helloWorker),
    (name = "counter", worker = .counterWorker),
    (name = "api", worker = .apiWorker),

    # Хранилище Durable Objects: volume workerd_data
    (name = "do-storage", disk = (path = "/data", writable = true)),
  ],
  sockets = [
    (name = "http", address = "*:8080", http = (), service = "gateway"),
  ],
);

# <имя>.workers.ava-kk.ru → биндинг с тем же именем
const gatewayWorker :Workerd.Worker = (
  modules = [
    (name = "index.js", esModule = embed "gateway/index.js"),
  ],
  compatibilityDate = "2026-09-01",
  bindings = [
    (name = "ROOT_DOMAIN", text = "workers.ava-kk.ru"),
    (name = "hello", service = "hello"),
    (name = "counter", service = "counter"),
    (name = "api", service = "api"),
  ],
);

# Заглушка Cloudflare API для wravler: api.workers.ava-kk.ru/client/v4
const apiWorker :Workerd.Worker = (
  modules = [
    (name = "index.js", esModule = embed "api/index.js"),
  ],
  compatibilityDate = "2026-09-01",
);

const helloWorker :Workerd.Worker = (
  modules = [
    (name = "index.js", esModule = embed "hello/index.js"),
  ],
  compatibilityDate = "2026-09-01",
);

const counterWorker :Workerd.Worker = (
  modules = [
    (name = "index.js", esModule = embed "counter/index.js"),
  ],
  compatibilityDate = "2026-09-01",
  durableObjectNamespaces = [
    (className = "Counter", uniqueKey = "counter-Counter", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "do-storage"),
  bindings = [
    (name = "COUNTER", durableObjectNamespace = "Counter"),
  ],
);
