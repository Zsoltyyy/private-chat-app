const API_URL = import.meta.env.VITE_API_URL || "";

export function getToken() {
  return localStorage.getItem("token");
}

export function setSession(token, user) {
  localStorage.setItem("token", token);
  localStorage.setItem("user", JSON.stringify(user));
}

export function updateStoredUser(user) {
  localStorage.setItem("user", JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
}

export function getStoredUser() {
  const raw = localStorage.getItem("user");

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    clearSession();
    return null;
  }
}

export async function api(path, options = {}) {
  const token = getToken();

  let response;

  try {
    const isRaw = options.raw === true;
    const headers = {
      ...(isRaw ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    };

    const fetchOpts = {
      ...options,
      headers
    };

    if (isRaw) {
      // let caller provide FormData or other body; do not stringify or set content-type
      delete fetchOpts.raw;
    }

    response = await fetch(`${API_URL}${path}`, fetchOpts);
  } catch {
    throw new Error("Nem sikerült kapcsolódni a szerverhez. Fut a backend?");
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Szerverhiba: ${response.status}`);
  }

  return data;
}
