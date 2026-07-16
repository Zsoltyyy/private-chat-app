import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import bcrypt from "bcrypt";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import {
  createUser,
  findUserByUsername,
  findUserById,
  getAllUsersExcept,
  getConversation,
  saveMessage,
  updateUserProfile
} from "./db.js";
import { authMiddleware, signToken, verifyToken } from "./auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 4000;
const CLIENT_URL = process.env.CLIENT_URL || "";
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,24}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const clientDistPath = path.resolve(__dirname, "../../client/dist");

const app = express();
const server = http.createServer(app);
const corsOptions = {
  origin: CLIENT_URL || true,
  methods: ["GET", "POST", "PATCH"]
};

const io = new Server(server, { cors: corsOptions });

app.use(cors(corsOptions));
app.use(express.json({ limit: "32kb" }));

const onlineUsers = new Map();

function getOnlineUserIds() {
  return Array.from(onlineUsers.keys()).map(Number);
}

function emitOnlineUsers() {
  io.emit("users:online", getOnlineUserIds());
}

function normalizeUsername(username) {
  return String(username || "").trim();
}

function validateCredentials(username, password) {
  if (!username || !password) {
    return "Felhasználónév és jelszó kötelező.";
  }

  if (!USERNAME_PATTERN.test(username)) {
    return "A felhasználónév 3-24 karakter lehet, betűkkel, számokkal, ponttal, kötőjellel vagy aláhúzással.";
  }

  if (String(password).length < 8) {
    return "A jelszó legalább 8 karakter legyen.";
  }

  return null;
}

function toSafeUser(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    avatar_color: user.avatar_color
  };
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/auth/register", async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || "");
    const validationError = validateCredentials(username, password);

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const existingUser = findUserByUsername(username);

    if (existingUser) {
      return res.status(409).json({ error: "Ez a felhasználónév már foglalt." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = createUser(username, passwordHash);
    const user = {
      id: result.lastInsertRowid,
      username,
      display_name: null,
      avatar_color: "#3466f6"
    };

    res.status(201).json({ token: signToken(user), user });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Szerverhiba regisztráció közben." });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || "");
    const user = findUserByUsername(username);

    if (!user) {
      return res.status(401).json({ error: "Hibás felhasználónév vagy jelszó." });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: "Hibás felhasználónév vagy jelszó." });
    }

    const safeUser = toSafeUser(user);

    res.json({ token: signToken(safeUser), user: safeUser });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Szerverhiba bejelentkezés közben." });
  }
});

app.get("/me", authMiddleware, (req, res) => {
  const user = findUserById(req.user.id);

  if (!user) {
    return res.status(404).json({ error: "Felhasználó nem található." });
  }

  res.json({ user });
});

app.patch("/me/profile", authMiddleware, (req, res) => {
  const displayName = String(req.body.displayName || "").trim().slice(0, 40) || null;
  const avatarColor = String(req.body.avatarColor || "#3466f6").trim();

  if (!COLOR_PATTERN.test(avatarColor)) {
    return res.status(400).json({ error: "Érvénytelen avatar szín." });
  }

  const user = updateUserProfile(req.user.id, { displayName, avatarColor });

  res.json({ user: toSafeUser(user) });
});

app.get("/users", authMiddleware, (req, res) => {
  res.json({
    users: getAllUsersExcept(req.user.id),
    onlineUserIds: getOnlineUserIds()
  });
});

app.get("/messages/:userId", authMiddleware, (req, res) => {
  const otherUserId = Number(req.params.userId);

  if (!otherUserId) {
    return res.status(400).json({ error: "Érvénytelen felhasználó." });
  }

  if (!findUserById(otherUserId)) {
    return res.status(404).json({ error: "A címzett nem található." });
  }

  res.json({ messages: getConversation(req.user.id, otherUserId) });
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(clientDistPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
}

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error("Hiányzó token."));
    }

    const user = verifyToken(token);
    socket.user = user;

    next();
  } catch {
    next(new Error("Érvénytelen token."));
  }
});

io.on("connection", (socket) => {
  const userId = socket.user.id;

  socket.join(`user:${userId}`);
  onlineUsers.set(userId, socket.id);
  emitOnlineUsers();

  socket.on("message:send", (payload, callback) => {
    try {
      const receiverId = Number(payload?.receiverId);
      const content = String(payload?.content || "").trim();

      if (!receiverId || !content) {
        return callback?.({ ok: false, error: "Címzett és üzenet kötelező." });
      }

      if (receiverId === userId) {
        return callback?.({ ok: false, error: "Magadnak nem küldhetsz üzenetet." });
      }

      if (!findUserById(receiverId)) {
        return callback?.({ ok: false, error: "A címzett nem található." });
      }

      if (content.length > 8000) {
        return callback?.({ ok: false, error: "Az üzenet túl hosszú." });
      }

      const message = saveMessage(userId, receiverId, content);

      io.to(`user:${receiverId}`).emit("message:new", message);
      socket.emit("message:new", message);

      callback?.({ ok: true, message });
    } catch (error) {
      console.error("Message error:", error);
      callback?.({ ok: false, error: "Nem sikerült elküldeni az üzenetet." });
    }
  });

  socket.on("disconnect", () => {
    const currentSocketId = onlineUsers.get(userId);

    if (currentSocketId === socket.id) {
      onlineUsers.delete(userId);
    }

    emitOnlineUsers();
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
