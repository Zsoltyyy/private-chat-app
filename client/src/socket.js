import { io } from "socket.io-client";
import { getToken } from "./api";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL || window.location.origin;

let socket = null;

export function connectSocket() {
  const token = getToken();

  if (!token) {
    return null;
  }

  if (socket?.connected) {
    return socket;
  }

  socket = io(SOCKET_URL, {
    auth: { token },
    autoConnect: true
  });

  return socket;
}

export function getSocket() {
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
