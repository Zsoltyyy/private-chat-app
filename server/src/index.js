import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import bcrypt from "bcrypt";
import nodemailer from "nodemailer";
import path from "path";
import webpush from "web-push";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import {
  createUser,
  createInviteCode,
  deletePushSubscription,
  deleteUserById,
  findUnusedInviteCode,
  findUserByEmail,
  findUserByUsername,
  findUserById,
  getAdminUsers,
  getAllUsersExcept,
  getConversation,
  getInviteCodes,
  getLatestEmailVerificationCode,
  getPushSubscriptionsForUser,
  markInviteCodeUsed,
  markEmailVerificationCodeUsed,
  saveEmailVerificationCode,
  saveMessage,
  savePushSubscription,
  updateUserProfile
} from "./db.js";
import { authMiddleware, signToken, verifyToken } from "./auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 4000;
const CLIENT_URL = process.env.CLIENT_URL || "";
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,24}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const clientDistPath = path.resolve(__dirname, "../../client/dist");

const app = express();
const server = http.createServer(app);
const corsOptions = {
  origin: CLIENT_URL || true,
  methods: ["GET", "POST", "PATCH", "DELETE"]
};

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@example.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

const io = new Server(server, { cors: corsOptions });

app.use(cors(corsOptions));
app.use(express.json({ limit: "1.5mb" }));

const onlineUsers = new Map();
const mailTransport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined
    })
  : null;

function getOnlineUserIds() {
  return Array.from(onlineUsers.entries())
    .filter(([, socketIds]) => socketIds.size > 0)
    .map(([userId]) => Number(userId));
}

function emitOnlineUsers() {
  io.emit("users:online", getOnlineUserIds());
}

function emitUsersChanged() {
  io.emit("users:changed");
}

function normalizeUsername(username) {
  return String(username || "").trim();
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function createVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function createInviteCodeValue() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const raw = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return `PRIV-${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function isAdmin(user) {
  return user?.username === "ZsoltY";
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
    email: user.email,
    email_verified: user.email_verified,
    display_name: user.display_name,
    avatar_color: user.avatar_color
  };
}

async function sendEmail({ to, subject, text }) {
  if (!to) return false;

  if (process.env.RESEND_API_KEY) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || "Privát Chat <onboarding@resend.dev>",
        to,
        subject,
        text
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Resend email error: ${response.status} ${errorText}`);
    }

    return true;
  }

  if (!mailTransport) {
    console.log(`[DEV EMAIL] To: ${to}\nSubject: ${subject}\n${text}`);
    return false;
  }

  await mailTransport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text
  });

  return true;
}

async function sendVerificationEmail(email, code) {
  await sendEmail({
    to: email,
    subject: "Privát Chat megerősítő kód",
    text: `A Privát Chat megerősítő kódod: ${code}\n\nA kód 10 percig érvényes.`
  });
}

async function sendPushToUser(userId, payload) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;

  const subscriptions = getPushSubscriptionsForUser(userId);

  await Promise.allSettled(
    subscriptions.map(async ({ id, subscription }) => {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          deletePushSubscription(id);
        } else {
          console.error("Push error:", error.message);
        }
      }
    })
  );
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/push/vapid-public-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || "" });
});

app.post("/push/subscribe", authMiddleware, (req, res) => {
  if (!req.body?.endpoint) {
    return res.status(400).json({ error: "Hiányzó push subscription." });
  }

  savePushSubscription(req.user.id, req.body);
  res.json({ ok: true });
});

app.post("/auth/request-code", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: "Érvényes email cím szükséges." });
    }

    if (findUserByEmail(email)) {
      return res.status(409).json({ error: "Ezzel az email címmel már van fiók." });
    }

    const code = createVerificationCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    saveEmailVerificationCode(email, codeHash, expiresAt);
    await sendVerificationEmail(email, code);

    res.json({
      ok: true,
      message: mailTransport
        ? "Elküldtük a megerősítő kódot emailben."
        : "Email küldés még nincs beállítva, a kód a szerver logban látszik."
    });
  } catch (error) {
    console.error("Verification code error:", error);
    res.status(500).json({ error: "Nem sikerült elküldeni a megerősítő kódot." });
  }
});

app.post("/auth/register", async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const inviteCodeValue = String(req.body.inviteCode || req.body.verificationCode || "").trim().toUpperCase();
    const validationError = validateCredentials(username, password);

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    if (email && !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: "Érvényes email cím szükséges, vagy hagyd üresen." });
    }

    if (!inviteCodeValue) {
      return res.status(400).json({ error: "Meghívókód szükséges." });
    }

    if (findUserByUsername(username)) {
      return res.status(409).json({ error: "Ez a felhasználónév már foglalt." });
    }

    if (email && findUserByEmail(email)) {
      return res.status(409).json({ error: "Ezzel az email címmel már van fiók." });
    }

    const inviteCode = findUnusedInviteCode(inviteCodeValue);

    if (!inviteCode) {
      return res.status(400).json({ error: "Hibás vagy már felhasznált meghívókód." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = createUser(username, passwordHash, email || null);
    markInviteCodeUsed(inviteCode.id, result.lastInsertRowid);

    const user = {
      id: result.lastInsertRowid,
      username,
      email: email || null,
      email_verified: 1,
      display_name: null,
      avatar_color: "#3466f6"
    };

    emitUsersChanged();
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
    const user = findUserByUsername(username) || findUserByEmail(normalizeEmail(username));

    if (!user) {
      return res.status(401).json({ error: "Hibás felhasználónév/email vagy jelszó." });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: "Hibás felhasználónév/email vagy jelszó." });
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
  const safeUser = toSafeUser(user);

  io.to(`user:${req.user.id}`).emit("profile:updated", safeUser);
  emitUsersChanged();
  res.json({ user: safeUser });
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

app.get("/admin/status", authMiddleware, (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Nincs jogosultság." });
  }

  res.json({
    users: getAdminUsers(),
    inviteCodes: getInviteCodes(),
    onlineUserIds: getOnlineUserIds(),
    onlineConnections: Array.from(onlineUsers.entries()).map(([userId, socketIds]) => ({
      userId: Number(userId),
      sockets: socketIds.size
    })),
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.post("/admin/invite-codes", authMiddleware, (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Nincs jogosultság." });
  }

  let code = createInviteCodeValue();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      try {
        createInviteCode(code, req.user.id);
      } catch (error) {
        if (!String(error.message || "").includes("FOREIGN KEY")) throw error;
        createInviteCode(code, null);
      }
      return res.status(201).json({
        code,
        inviteCodes: getInviteCodes()
      });
    } catch (error) {
      if (!String(error.message || "").includes("UNIQUE")) throw error;
      code = createInviteCodeValue();
    }
  }

  res.status(500).json({ error: "Nem sikerült meghívókódot generálni." });
});

app.delete("/admin/users/:userId", authMiddleware, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Nincs jogosultság." });
  }

  const userId = Number(req.params.userId);

  if (!userId) {
    return res.status(400).json({ error: "Érvénytelen felhasználó." });
  }

  if (userId === req.user.id) {
    return res.status(400).json({ error: "Saját admin fiókot nem törölhetsz." });
  }

  const user = findUserById(userId);

  if (!user) {
    return res.status(404).json({ error: "Felhasználó nem található." });
  }

  deleteUserById(userId);
  io.to(`user:${userId}`).emit("account:deleted");
  emitUsersChanged();
  emitOnlineUsers();

  await sendEmail({
    to: user.email,
    subject: "Privát Chat fiók törölve",
    text: `Szia ${user.display_name || user.username}!\n\nA Privát Chat fiókodat egy admin törölte.\n\nHa szerinted ez tévedés, keresd Zsoltot.`
  });

  res.json({ ok: true });
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
  const socketIds = onlineUsers.get(userId) || new Set();
  socketIds.add(socket.id);
  onlineUsers.set(userId, socketIds);
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

      const receiver = findUserById(receiverId);

      if (!receiver) {
        return callback?.({ ok: false, error: "A címzett nem található." });
      }

      if (content.length > 900000) {
        return callback?.({ ok: false, error: "Az üzenet vagy kép túl nagy." });
      }

      const message = saveMessage(userId, receiverId, content);
      const sender = findUserById(userId);

      io.to(`user:${receiverId}`).emit("message:new", message);
      socket.emit("message:new", message);
      sendPushToUser(receiverId, {
        title: sender?.display_name || sender?.username || "Privát Chat",
        body: "Új titkosított üzeneted érkezett.",
        url: "/"
      });

      callback?.({ ok: true, message });
    } catch (error) {
      console.error("Message error:", error);
      callback?.({ ok: false, error: "Nem sikerült elküldeni az üzenetet." });
    }
  });

  socket.on("disconnect", () => {
    const socketIds = onlineUsers.get(userId);

    if (socketIds) {
      socketIds.delete(socket.id);
    }

    if (!socketIds || socketIds.size === 0) {
      onlineUsers.delete(userId);
    }

    emitOnlineUsers();
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
