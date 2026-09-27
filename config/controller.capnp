# Контроллер контейнеров воркеров (workers/controller). Единственный процесс с доступом
# к Docker: слушает только сеть workerd_control (там кроме него лишь платформа).
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "controller", worker = .controller),
    (name = "docker", external = (address = "unix:/var/run/docker.sock", http = ())),
  ],
  sockets = [
    (name = "http", address = "*:8090", http = (), service = "controller"),
  ],
);

const controller :Workerd.Worker = (
  modules = [
    (name = "index.js", esModule = embed "controller/index.js"),
  ],
  compatibilityDate = "2026-09-01",
  bindings = [
    (name = "DOCKER", service = "docker"),
    (name = "TOKEN", fromEnvironment = "WRAVLER_TOKEN"),
    # параметры контейнеров воркеров — из compose (deploy/compose.yaml)
    (name = "RUNNER_IMAGE", fromEnvironment = "RUNNER_IMAGE"),
    (name = "DATA_VOLUME", fromEnvironment = "DATA_VOLUME"),
    (name = "NETWORK", fromEnvironment = "RUNNER_NETWORK"),
    (name = "RUNNER_MEMORY_MB", fromEnvironment = "RUNNER_MEMORY_MB"),
    (name = "RUNNER_CPUS", fromEnvironment = "RUNNER_CPUS"),
  ],
);
