import { api } from "./api";

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

export function isPushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function enablePushNotifications() {
  if (!isPushSupported()) {
    throw new Error("Ez a böngésző nem támogatja a push értesítéseket.");
  }

  const permission = await Notification.requestPermission();

  if (permission !== "granted") {
    throw new Error("Az értesítési engedély nincs megadva.");
  }

  const { publicKey } = await api("/push/vapid-public-key");

  if (!publicKey) {
    throw new Error("A szerveren még nincs beállítva VAPID push kulcs.");
  }

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
  }

  await api("/push/subscribe", {
    method: "POST",
    body: JSON.stringify(subscription)
  });

  return subscription;
}
