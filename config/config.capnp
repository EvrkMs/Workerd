# Конфиг платформы. Статичный: деплой воркеров его не меняет —
# код воркеров лежит в реестре (DO в api) и загружается gateway через Worker Loader.
# Worker Loader экспериментальный: нужен флаг --experimental (compose command)
# и compatibilityFlags = ["experimental"] у gateway.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "gateway", worker = .gatewayWorker),
    (name = "api", worker = .apiWorker),

    # Хранилище Durable Objects и файлов статики: volume workerd_data.
    # Путь должен существовать при старте, иначе workerd не запустится — поэтому
    # статика лежит внутри /data (assets/<hh>/<hash>), а не отдельным сервисом.
    (name = "storage", disk = (path = "/data", writable = true)),
    # то же, только чтение — для gateway (раздача статики)
    (name = "storage-ro", disk = (path = "/data")),
    # собранная веб-панель (panel/dist в образе) — раздаёт api на panel.<ROOT_DOMAIN>
    (name = "panel-ui", disk = (path = "/app/panel")),

    # Выход наружу для fetch()/WebSocket/connect() всех воркеров, включая загруженные
    # на лету (они наследуют "internet"). Сам workerd в internal-сети маршрута наружу
    # не имеет — всё идёт через egress, который пускает только на публичные адреса.
    (name = "internet", external = (address = "egress:8080", http = (style = proxy))),
  ],
  sockets = [
    (name = "http", address = "*:8080", http = (), service = "gateway"),
  ],
);

# <имя>.<ROOT_DOMAIN> → воркер из реестра; api.<ROOT_DOMAIN> → api
const gatewayWorker :Workerd.Worker = (
  modules = [
    (name = "index.js", esModule = embed "gateway/index.js"),
  ],
  compatibilityDate = "2026-09-01",
  compatibilityFlags = ["experimental"],
  # Host: один DO на каждый объект Durable Object пользовательских воркеров;
  # класс пользователя живёт внутри как facet со своей SQLite (workers/gateway/src/durable.ts)
  durableObjectNamespaces = [
    (className = "Host", uniqueKey = "platform-Host", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "storage"),
  bindings = [
    (name = "ROOT_DOMAIN", fromEnvironment = "ROOT_DOMAIN"),  # из deploy/.env
    (name = "API", service = "api"),
    # события загруженных воркеров → wravler tail (TailForwarder в gateway → api)
    (name = "TAIL", service = (name = "api", entrypoint = "TailIngest")),
    (name = "LOADER", workerLoader = ()),
    (name = "REGISTRY", durableObjectNamespace = (className = "Registry", serviceName = "api")),
    (name = "HOST", durableObjectNamespace = "Host"),
    (name = "ASSET_FILES", service = "storage-ro"),
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
    (name = "ROOT_DOMAIN", fromEnvironment = "ROOT_DOMAIN"),  # из deploy/.env
    (name = "API_TOKEN", fromEnvironment = "WRAVLER_TOKEN"),
    (name = "REGISTRY", durableObjectNamespace = "Registry"),
    (name = "TAILS", durableObjectNamespace = "TailHub"),
    (name = "STORAGE", service = "storage"),  # запись файлов статики
    (name = "PANEL_UI", service = "panel-ui"),
  ],
);
