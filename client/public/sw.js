const CACHE_NAME = "private-chat-v4";
const STATIC_ASSETS = ["/manifest.webmanifest", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const request = event.request;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => response)
        .catch(() => caches.match("/"))
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request))
  );
});

self.addEventListener("push", (event) => {
  let data = {};

  try {
    data = event.data?.json() || {};
  } catch {
    data = {};
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "Privát Chat", {
      body: data.body || "Új üzeneted érkezett.",
      icon: "/icons/icon.svg",
      badge: "/icons/icon.svg",
      tag: data.tag || "private-chat-message",
      renotify: true,
      requireInteraction: false,
      vibrate: [120, 60, 120],
      data: {
        url: data.url || "/"
      }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;
      const existingClient = clients.find((client) => client.url.startsWith(self.location.origin));

      if (existingClient) {
        existingClient.navigate(targetUrl);
        return existingClient.focus();
      }

      return self.clients.openWindow(targetUrl);
    })
  );
});
