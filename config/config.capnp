using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "hello", worker = .helloWorker),
  ],
  sockets = [
    (name = "http", address = "*:8080", http = (), service = "hello"),
  ],
);

const helloWorker :Workerd.Worker = (
  modules = [
    (name = "index.js", esModule = embed "hello/index.js"),
  ],
  compatibilityDate = "2026-09-01",
);
