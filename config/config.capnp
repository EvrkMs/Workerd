# Конфиг платформы. Статичный: деплой воркеров его не меняет —
# код воркеров лежит в реестре (DO в api) и загружается gateway через Worker Loader.
# Worker Loader экспериментальный: нужен флаг --experimental (compose command)
# и compatibilityFlags = ["experimental"] у gateway.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "gateway", worker = .gatewayWorker),
    (name = "api", worker = .apiWorker),

    # Хранилище Durable Objects: volume workerd_data
    (name = "storage", disk = (path = "/data", writable = true)),

    # Выход наружу для fetch()/WebSocket/connect() всех воркеров, включая загруженные
    # на лету (они наследуют "internet"). Сам workerd в internal-сети маршрута наружу
    # не имеет — всё идёт через egress, который пускает только на публичные адреса.
    (name = "internet", external = (address = "egress:8080", http = (style = proxy))),
  ],
  sockets = [
    (name = "http", address = "*:8080", http = (), service = "gateway"),
  ],
);

# <имя>.workers.ava-kk.ru → воркер из реестра; api.workers.ava-kk.ru → api
const gatewayWorker :Workerd.Worker = (
  modules = [
    (name = "index.js", esModule = embed "gateway/index.js"),
  ],
  compatibilityDate = "2026-09-01",
  compatibilityFlags = ["experimental"],
  bindings = [
    (name = "ROOT_DOMAIN", text = "workers.ava-kk.ru"),
    (name = "API", service = "api"),
    (name = "LOADER", workerLoader = ()),
    (name = "REGISTRY", durableObjectNamespace = (className = "Registry", serviceName = "api")),
  ],
);

# API в формате Cloudflare (/client/v4) для wravler + реестр воркеров
const apiWorker :Workerd.Worker = (
  modules = [
    (name = "index.js", esModule = embed "api/index.js"),
  ],
  compatibilityDate = "2026-09-01",
  durableObjectNamespaces = [
    (className = "Registry", uniqueKey = "platform-Registry", enableSql = true),
    (className = "TailHub", uniqueKey = "platform-TailHub", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "storage"),
  bindings = [
    (name = "ROOT_DOMAIN", text = "workers.ava-kk.ru"),
    (name = "API_TOKEN", fromEnvironment = "WRAVLER_TOKEN"),
    (name = "REGISTRY", durableObjectNamespace = "Registry"),
    (name = "TAILS", durableObjectNamespace = "TailHub"),
  ],
);
