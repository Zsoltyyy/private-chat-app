const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function getConversationSalt(userId, otherUserId) {
  const ids = [Number(userId), Number(otherUserId)].sort((a, b) => a - b);
  return encoder.encode(`private-chat:e2ee:${ids[0]}:${ids[1]}`);
}

async function deriveKey(secret, userId, otherUserId) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: getConversationSalt(userId, otherUserId),
      iterations: 250000,
      hash: "SHA-256"
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export function getStoredChatSecret() {
  return localStorage.getItem("chatSecret") || "";
}

export function setStoredChatSecret(secret) {
  localStorage.setItem("chatSecret", secret);
}

export function clearStoredChatSecret() {
  localStorage.removeItem("chatSecret");
}

export async function encryptMessage(plainText, secret, userId, otherUserId) {
  const key = await deriveKey(secret, userId, otherUserId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plainText)
  );

  return JSON.stringify({
    v: 1,
    alg: "AES-GCM",
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(cipherBytes))
  });
}

export async function decryptMessage(cipherText, secret, userId, otherUserId) {
  if (!cipherText?.startsWith("{")) {
    return cipherText;
  }

  const payload = JSON.parse(cipherText);

  if (payload.v !== 1 || payload.alg !== "AES-GCM") {
    throw new Error("Unsupported encrypted message.");
  }

  const key = await deriveKey(secret, userId, otherUserId);
  const plainBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
    key,
    base64ToBytes(payload.data)
  );

  return decoder.decode(plainBytes);
}
