# Конфиг платформы. Статичный: деплой воркеров его не меняет.
# Код воркеров лежит в реестре (DO в api); каждый воркер с кодом работает в своём
# контейнере worker-<имя> со своим процессом workerd (workers/api/src/orchestrator.ts).
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "gateway", worker = .gatewayWorker),
    (name = "api", worker = .apiWorker),

    # Хранилище DO платформы, файлов статики и данных DO воркеров (workers/<имя>):
    # volume workerd_data. Путь должен существовать при старте, иначе workerd не запустится.
    (name = "storage", disk = (path = "/data", writable = true)),
    # то же, только чтение — для gateway (раздача статики)
    (name = "storage-ro", disk = (path = "/data")),
    # собранная веб-панель (panel/dist в образе) — раздаёт api на panel.<ROOT_DOMAIN>
    (name = "panel-ui", disk = (path = "/app/panel")),

    # Контейнеры воркеров (worker-<имя>:8080/8081, сеть workerd_internal) и контроллер
    # (controller:8090, сеть workerd_control). У платформы других сетей с частными
    # адресами нет, так что "private" — только они. Именно network, а не external:
    # external разрешает имя один раз, и после пересоздания контейнера (новый IP) связь
    # теряется; network разрешает имя на каждый запрос.
    (name = "runners", network = (allow = ["private"])),

    # Выход наружу для fetch() самой платформы — через egress, только публичные адреса.
    (name = "internet", external = (address = "egress:8080", http = (style = proxy))),
  ],
  sockets = [
    # вход от Caddy: <имя>.<ROOT_DOMAIN>, api., panel.
    (name = "http", address = "*:8080", http = (), service = "gateway"),
    # вход от контейнеров воркеров: события tail, env.ASSETS (запросы подписаны их токеном)
    (name = "internal", address = "*:8081", http = (), service = (name = "gateway", entrypoint = "Internal")),
  ],
);

const gatewayWorker :Workerd.Worker = (
  modules = [
    (name = "index.js", esModule = embed "gateway/index.js"),
  ],
  compatibilityDate = "2026-09-01",
  bindings = [
    (name = "ROOT_DOMAIN", fromEnvironment = "ROOT_DOMAIN"),  # из deploy/.env
    (name = "API_TOKEN", fromEnvironment = "WRAVLER_TOKEN"),
    (name = "API", service = "api"),
    # события контейнеров → wravler tail
    (name = "TAIL", service = (name = "api", entrypoint = "TailIngest")),
    (name = "REGISTRY", durableObjectNamespace = (className = "Registry", serviceName = "api")),
    (name = "ORCHESTRATOR", durableObjectNamespace = (className = "Orchestrator", serviceName = "api")),
    (name = "RUNNERS", service = "runners"),
    (name = "ASSET_FILES", service = "storage-ro"),
  ],
);

# API в формате Cloudflare (/client/v4) для wravler, реестр, оркестратор, панель
const apiWorker :Workerd.Worker = (
  modules = [
    (name = "index.js", esModule = embed "api/index.js"),
  ],
  compatibilityDate = "2026-09-01",
  durableObjectNamespaces = [
    (className = "Registry", uniqueKey = "platform-Registry", enableSql = true),
    (className = "TailHub", uniqueKey = "platform-TailHub", enableSql = true),
    (className = "Orchestrator", uniqueKey = "platform-Orchestrator", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "storage"),
  bindings = [
    (name = "ROOT_DOMAIN", fromEnvironment = "ROOT_DOMAIN"),  # из deploy/.env
    (name = "API_TOKEN", fromEnvironment = "WRAVLER_TOKEN"),
    (name = "REGISTRY", durableObjectNamespace = "Registry"),
    (name = "TAILS", durableObjectNamespace = "TailHub"),
    (name = "ORCHESTRATOR", durableObjectNamespace = "Orchestrator"),
    (name = "STORAGE", service = "storage"),  # запись файлов статики, каталоги workers/<имя>
    (name = "RUNNERS", service = "runners"),
    (name = "PANEL_UI", service = "panel-ui"),
  ],
);
