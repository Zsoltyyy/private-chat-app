import Database from "better-sqlite3";

export const db = new Database(process.env.DATABASE_PATH || "chat.db");

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 1,
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

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    subscription_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS email_verification_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const userColumns = db.prepare("PRAGMA table_info(users)").all().map((column) => column.name);

if (!userColumns.includes("display_name")) {
  db.prepare("ALTER TABLE users ADD COLUMN display_name TEXT").run();
}

if (!userColumns.includes("email")) {
  db.prepare("ALTER TABLE users ADD COLUMN email TEXT").run();
}

if (!userColumns.includes("email_verified")) {
  db.prepare("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1").run();
}

if (!userColumns.includes("avatar_color")) {
  db.prepare("ALTER TABLE users ADD COLUMN avatar_color TEXT NOT NULL DEFAULT '#3466f6'").run();
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users(lower(email))
  WHERE email IS NOT NULL;
`);

export function createUser(username, passwordHash, email = null) {
  return db.prepare(`
    INSERT INTO users (username, email, email_verified, password_hash)
    VALUES (?, ?, ?, ?)
  `).run(username, email, email ? 1 : 1, passwordHash);
}

export function findUserByUsername(username) {
  return db.prepare(`
    SELECT * FROM users
    WHERE lower(username) = lower(?)
  `).get(username);
}

export function findUserByEmail(email) {
  return db.prepare(`
    SELECT * FROM users
    WHERE lower(email) = lower(?)
  `).get(email);
}

export function findUserById(id) {
  return db.prepare(`
    SELECT id, username, email, email_verified, display_name, avatar_color, created_at
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

export function getAdminUsers() {
  return db.prepare(`
    SELECT
      u.id,
      u.username,
      u.email,
      u.email_verified,
      u.display_name,
      u.avatar_color,
      u.created_at,
      (
        SELECT count(*)
        FROM messages m
        WHERE m.sender_id = u.id OR m.receiver_id = u.id
      ) AS message_count
    FROM users u
    ORDER BY u.created_at DESC, u.id DESC
  `).all();
}

export function deleteUserById(userId) {
  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM push_subscriptions WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?").run(userId, userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  });

  transaction();
}

export function saveEmailVerificationCode(email, codeHash, expiresAt) {
  db.prepare(`
    INSERT INTO email_verification_codes (email, code_hash, expires_at)
    VALUES (?, ?, ?)
  `).run(email, codeHash, expiresAt);
}

export function getLatestEmailVerificationCode(email) {
  return db.prepare(`
    SELECT *
    FROM email_verification_codes
    WHERE lower(email) = lower(?)
      AND used_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(email);
}

export function markEmailVerificationCodeUsed(id) {
  db.prepare(`
    UPDATE email_verification_codes
    SET used_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
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

export function savePushSubscription(userId, subscription) {
  const subscriptionJson = JSON.stringify(subscription);

  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, subscription_json)
    VALUES (?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id,
      subscription_json = excluded.subscription_json
  `).run(userId, subscription.endpoint, subscriptionJson);
}

export function getPushSubscriptionsForUser(userId) {
  return db.prepare(`
    SELECT id, subscription_json
    FROM push_subscriptions
    WHERE user_id = ?
  `).all(userId).map((row) => ({
    id: row.id,
    subscription: JSON.parse(row.subscription_json)
  }));
}

export function deletePushSubscription(id) {
  db.prepare(`
    DELETE FROM push_subscriptions
    WHERE id = ?
  `).run(id);
}
