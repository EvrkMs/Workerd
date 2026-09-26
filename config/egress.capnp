# egress — единственный выход платформы наружу.
#
# workerd сидит в internal-сети workerd_internal: шлюза нет, до хоста, LAN, соседних
# контейнеров и интернета маршрута нет вообще. Весь исходящий трафик воркеров
# (fetch, WebSocket, connect()) идёт сюда — через сервис "internet" в config.capnp.
#
# Здесь нет JS: сокет принимает запросы в формате HTTP-прокси и выпускает их
# только на публичные адреса. Приватные (10/8, 172.16/12, 192.168/16, 127/8 …)
# отклоняются: connect() blocked by restrictPeers().
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "public", network = (
      allow = ["public"],
      tlsOptions = (trustBrowserCas = true),  # без этого HTTPS наружу не работает
    )),
  ],
  sockets = [
    (name = "proxy", address = "*:8080", http = (style = proxy), service = "public"),
  ],
);
