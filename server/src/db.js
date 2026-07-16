import Database from "better-sqlite3";

export const db = new Database(process.env.DATABASE_PATH || "chat.db");

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT,
    avatar_color TEXT NOT NULL DEFAULT '#3466f6',
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(sender_id) REFERENCES users(id),
    FOREIGN KEY(receiver_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_pair_created
  ON messages(sender_id, receiver_id, created_at);
`);

const userColumns = db.prepare("PRAGMA table_info(users)").all().map((column) => column.name);

if (!userColumns.includes("display_name")) {
  db.prepare("ALTER TABLE users ADD COLUMN display_name TEXT").run();
}

if (!userColumns.includes("avatar_color")) {
  db.prepare("ALTER TABLE users ADD COLUMN avatar_color TEXT NOT NULL DEFAULT '#3466f6'").run();
}

export function createUser(username, passwordHash) {
  return db.prepare(`
    INSERT INTO users (username, password_hash)
    VALUES (?, ?)
  `).run(username, passwordHash);
}

export function findUserByUsername(username) {
  return db.prepare(`
    SELECT * FROM users
    WHERE lower(username) = lower(?)
  `).get(username);
}

export function findUserById(id) {
  return db.prepare(`
    SELECT id, username, display_name, avatar_color, created_at
    FROM users
    WHERE id = ?
  `).get(id);
}

export function getAllUsersExcept(userId) {
  return db.prepare(`
    SELECT id, username, display_name, avatar_color
    FROM users
    WHERE id != ?
    ORDER BY coalesce(display_name, username) ASC
  `).all(userId);
}

export function updateUserProfile(userId, profile) {
  db.prepare(`
    UPDATE users
    SET display_name = ?, avatar_color = ?
    WHERE id = ?
  `).run(profile.displayName, profile.avatarColor, userId);

  return findUserById(userId);
}

export function saveMessage(senderId, receiverId, content) {
  const result = db.prepare(`
    INSERT INTO messages (sender_id, receiver_id, content)
    VALUES (?, ?, ?)
  `).run(senderId, receiverId, content);

  return getMessageById(result.lastInsertRowid);
}

export function getMessageById(id) {
  return db.prepare(`
    SELECT
      m.id,
      m.sender_id,
      sender.username AS sender_username,
      m.receiver_id,
      receiver.username AS receiver_username,
      m.content,
      m.created_at
    FROM messages m
    JOIN users sender ON sender.id = m.sender_id
    JOIN users receiver ON receiver.id = m.receiver_id
    WHERE m.id = ?
  `).get(id);
}

export function getConversation(userA, userB) {
  return db.prepare(`
    SELECT
      m.id,
      m.sender_id,
      sender.username AS sender_username,
      m.receiver_id,
      receiver.username AS receiver_username,
      m.content,
      m.created_at
    FROM messages m
    JOIN users sender ON sender.id = m.sender_id
    JOIN users receiver ON receiver.id = m.receiver_id
    WHERE
      (m.sender_id = ? AND m.receiver_id = ?)
      OR
      (m.sender_id = ? AND m.receiver_id = ?)
    ORDER BY m.created_at ASC, m.id ASC
  `).all(userA, userB, userB, userA);
}
