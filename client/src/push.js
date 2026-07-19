import { api } from "./api";

const PUSH_ENABLED_KEY = "private-chat-push-enabled";

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

export function isPushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function isPushEnabledPreference() {
  return localStorage.getItem(PUSH_ENABLED_KEY) === "true";
}

export function setPushEnabledPreference(value) {
  if (value) {
    localStorage.setItem(PUSH_ENABLED_KEY, "true");
  } else {
    localStorage.removeItem(PUSH_ENABLED_KEY);
  }
}

export async function getPushSubscriptionState() {
  if (!isPushSupported()) {
    return { supported: false, permission: "unsupported", subscribed: false };
  }

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();

  return {
    supported: true,
    permission: Notification.permission,
    subscribed: Boolean(subscription),
    endpoint: subscription?.endpoint || ""
  };
}

export async function enablePushNotifications({ force = false } = {}) {
  if (!isPushSupported()) {
    throw new Error("Ez a böngésző nem támogatja a push értesítéseket.");
  }

  const permission = await Notification.requestPermission();

  if (permission !== "granted") {
    setPushEnabledPreference(false);
    throw new Error("Az értesítési engedély nincs megadva.");
  }

  const { publicKey } = await api("/push/vapid-public-key");

  if (!publicKey) {
    throw new Error("A szerveren még nincs beállítva VAPID push kulcs.");
  }

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();

  if (force && subscription) {
    await subscription.unsubscribe();
    subscription = null;
  }

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

  setPushEnabledPreference(true);
  return subscription;
}
