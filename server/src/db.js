import Database from "better-sqlite3";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL || "";
const usePostgres = Boolean(databaseUrl);

function createSqliteConnection() {
  const sqliteDb = new Database(process.env.DATABASE_PATH || "chat.db");
  sqliteDb.pragma("journal_mode = WAL");
  sqliteDb.pragma("foreign_keys = ON");
  return sqliteDb;
}

function createPostgresConnection() {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
  });

  return {
    kind: "postgres",
    pool,
    exec(query) {
      return pool.query(query);
    },
    pragma() {},
    prepare(statementSql) {
      return {
        run(...params) {
          return executePostgresStatement(pool, statementSql, params);
        },
        get(...params) {
          return executePostgresQuery(pool, statementSql, params, "get");
        },
        all(...params) {
          return executePostgresQuery(pool, statementSql, params, "all");
        }
      };
    }
  };
}

function executePostgresStatement(pool, statementSql, params) {
  // convert `?` placeholders to $1, $2... for pg
  let index = 0;
  const converted = statementSql.replace(/\?/g, () => `\$${++index}`);
  const normalizedSql = converted.trim();
  const shouldReturnId = /\binsert\b/i.test(normalizedSql) && !/\breturning\b/i.test(normalizedSql);
  const sql = shouldReturnId ? `${normalizedSql} RETURNING id` : normalizedSql;

  return pool.query(sql, params).then((result) => ({
    changes: result.rowCount ?? 0,
    lastInsertRowid: result.rows?.[0]?.id ?? null
  }));
}

function executePostgresQuery(pool, statementSql, params, mode) {
  // convert `?` placeholders to $1, $2... for pg
  let index = 0;
  const converted = statementSql.replace(/\?/g, () => `\$${++index}`);

  return pool.query(converted, params).then((result) => {
    if (mode === "get") {
      return result.rows[0] ?? null;
    }

    return result.rows;
  });
}

export const db = usePostgres ? createPostgresConnection() : createSqliteConnection();

function initializeSqliteSchema() {
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
      delivered_at TEXT,
      read_at TEXT,
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

    CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      created_by INTEGER,
      used_by INTEGER,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(created_by) REFERENCES users(id),
      FOREIGN KEY(used_by) REFERENCES users(id)
    );
  `);

  const userColumns = db.prepare("PRAGMA table_info(users)").all().map((column) => column.name);

  if (!userColumns.includes("is_admin")) {
    db.prepare("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0").run();
  }

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

  const messageColumns = db.prepare("PRAGMA table_info(messages)").all().map((column) => column.name);

  if (!messageColumns.includes("delivered_at")) {
    db.prepare("ALTER TABLE messages ADD COLUMN delivered_at TEXT").run();
  }

  if (!messageColumns.includes("read_at")) {
    db.prepare("ALTER TABLE messages ADD COLUMN read_at TEXT").run();
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
    ON users(lower(email))
    WHERE email IS NOT NULL;
  `);
}

async function initializePostgresSchema() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      is_admin INTEGER NOT NULL DEFAULT 0,
      email TEXT UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 1,
      display_name TEXT,
      avatar_color TEXT NOT NULL DEFAULT '#3466f6',
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      sender_id INTEGER NOT NULL,
      receiver_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      delivered_at TIMESTAMPTZ,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(sender_id) REFERENCES users(id),
      FOREIGN KEY(receiver_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_pair_created
    ON messages(sender_id, receiver_id, created_at);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      subscription_json TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS email_verification_codes (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      created_by INTEGER,
      used_by INTEGER,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(created_by) REFERENCES users(id),
      FOREIGN KEY(used_by) REFERENCES users(id)
    );
  `);

  const rows = await db.prepare(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
  `).all();

  const userColumns = (rows || []).map((column) => column.column_name);

  if (!userColumns.includes("is_admin")) {
    await db.prepare("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0").run();
  }

  if (!userColumns.includes("display_name")) {
    await db.prepare("ALTER TABLE users ADD COLUMN display_name TEXT").run();
  }

  if (!userColumns.includes("email")) {
    await db.prepare("ALTER TABLE users ADD COLUMN email TEXT").run();
  }

  if (!userColumns.includes("email_verified")) {
    await db.prepare("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1").run();
  }

  if (!userColumns.includes("avatar_color")) {
    await db.prepare("ALTER TABLE users ADD COLUMN avatar_color TEXT NOT NULL DEFAULT '#3466f6'").run();
  }

  const messageRows = await db.prepare(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
  `).all();

  const messageColumns = (messageRows || []).map((column) => column.column_name);

  if (!messageColumns.includes("delivered_at")) {
    await db.prepare("ALTER TABLE messages ADD COLUMN delivered_at TIMESTAMPTZ").run();
  }

  if (!messageColumns.includes("read_at")) {
    await db.prepare("ALTER TABLE messages ADD COLUMN read_at TIMESTAMPTZ").run();
  }

  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
    ON users(lower(email))
    WHERE email IS NOT NULL;
  `);
}

if (db.kind === "postgres") {
  await initializePostgresSchema();
} else {
  initializeSqliteSchema();
}

export async function createUser(username, passwordHash, email = null, isAdmin = 0) {
  return db.prepare(`
    INSERT INTO users (username, email, email_verified, password_hash, is_admin)
    VALUES (?, ?, ?, ?, ?)
  `).run(username, email, email ? 1 : 1, passwordHash, isAdmin ? 1 : 0);
}

export async function upsertAdminUser(username, passwordHash, email = null) {
  const existing = await findUserByUsername(username);

  if (existing) {
    await db.prepare(`
      UPDATE users
      SET password_hash = ?,
          email = coalesce(email, ?),
          email_verified = 1,
          is_admin = 1
      WHERE id = ?
    `).run(passwordHash, email, existing.id);

    return findUserByUsername(username);
  }

  await createUser(username, passwordHash, email || null, 1);
  return findUserByUsername(username);
}

export async function findUserByUsername(username) {
  return db.prepare(`
    SELECT * FROM users
    WHERE lower(username) = lower(?)
  `).get(username);
}

export async function findUserByEmail(email) {
  return db.prepare(`
    SELECT * FROM users
    WHERE lower(email) = lower(?)
  `).get(email);
}

export async function findUserById(id) {
  return db.prepare(`
    SELECT id, username, email, email_verified, display_name, avatar_color, created_at, is_admin
    FROM users
    WHERE id = ?
  `).get(id);
}

export async function getAllUsersExcept(userId) {
  return db.prepare(`
    SELECT
      u.id,
      u.username,
      u.display_name,
      u.avatar_color,
      u.is_admin,
      (
        SELECT count(*)
        FROM messages m
        WHERE m.sender_id = u.id
          AND m.receiver_id = ?
          AND m.read_at IS NULL
      ) AS unread_count
    FROM users u
    WHERE u.id != ?
    ORDER BY coalesce(u.display_name, u.username) ASC
  `).all(userId, userId);
}

export async function getAdminUsers() {
  return db.prepare(`
    SELECT
      u.id,
      u.username,
      u.email,
      u.email_verified,
      u.display_name,
      u.avatar_color,
      u.created_at,
      u.is_admin,
      (
        SELECT count(*)
        FROM messages m
        WHERE m.sender_id = u.id OR m.receiver_id = u.id
      ) AS message_count
    FROM users u
    ORDER BY u.created_at DESC, u.id DESC
  `).all();
}

export async function deleteUserById(userId) {
  if (db.kind === "postgres") {
    // Use explicit transaction for Postgres
    await db.exec("BEGIN");
    try {
      await db.prepare("UPDATE invite_codes SET used_by = NULL WHERE used_by = ?").run(userId);
      await db.prepare("UPDATE invite_codes SET created_by = NULL WHERE created_by = ?").run(userId);
      await db.prepare("DELETE FROM push_subscriptions WHERE user_id = ?").run(userId);
      await db.prepare("DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?").run(userId, userId);
      await db.prepare("DELETE FROM users WHERE id = ?").run(userId);
      await db.exec("COMMIT");
    } catch (err) {
      await db.exec("ROLLBACK");
      throw err;
    }
  } else {
    const transaction = db.transaction(() => {
      db.prepare("UPDATE invite_codes SET used_by = NULL WHERE used_by = ?").run(userId);
      db.prepare("UPDATE invite_codes SET created_by = NULL WHERE created_by = ?").run(userId);
      db.prepare("DELETE FROM push_subscriptions WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?").run(userId, userId);
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    });

    transaction();
  }
}

export async function saveEmailVerificationCode(email, codeHash, expiresAt) {
  await db.prepare(`
    INSERT INTO email_verification_codes (email, code_hash, expires_at)
    VALUES (?, ?, ?)
  `).run(email, codeHash, expiresAt);
}

export async function getLatestEmailVerificationCode(email) {
  return db.prepare(`
    SELECT *
    FROM email_verification_codes
    WHERE lower(email) = lower(?)
      AND used_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(email);
}

export async function markEmailVerificationCodeUsed(id) {
  await db.prepare(`
    UPDATE email_verification_codes
    SET used_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
}

export async function createInviteCode(code, createdBy) {
  return db.prepare(`
    INSERT INTO invite_codes (code, created_by)
    VALUES (?, ?)
  `).run(code, createdBy);
}

export async function getInviteCodes() {
  return db.prepare(`
    SELECT
      invite_codes.id,
      invite_codes.code,
      invite_codes.created_at,
      invite_codes.used_at,
      creator.username AS created_by_username,
      used_user.username AS used_by_username
    FROM invite_codes
    LEFT JOIN users creator ON creator.id = invite_codes.created_by
    LEFT JOIN users used_user ON used_user.id = invite_codes.used_by
    ORDER BY invite_codes.created_at DESC, invite_codes.id DESC
    LIMIT 25
  `).all();
}

export async function findUnusedInviteCode(code) {
  return db.prepare(`
    SELECT *
    FROM invite_codes
    WHERE upper(code) = upper(?)
      AND used_at IS NULL
    LIMIT 1
  `).get(code);
}

export async function markInviteCodeUsed(id, usedBy) {
  await db.prepare(`
    UPDATE invite_codes
    SET used_by = ?, used_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(usedBy, id);
}

export async function deleteInviteCodeById(id) {
  return db.prepare(`
    DELETE FROM invite_codes
    WHERE id = ?
  `).run(id);
}

export async function updateUserProfile(userId, profile) {
  await db.prepare(`
    UPDATE users
    SET display_name = ?, avatar_color = ?
    WHERE id = ?
  `).run(profile.displayName, profile.avatarColor, userId);

  return findUserById(userId);
}

export async function setUserAdminStatus(userId, isAdmin) {
  await db.prepare(`
    UPDATE users
    SET is_admin = ?
    WHERE id = ?
  `).run(isAdmin ? 1 : 0, userId);

  return findUserById(userId);
}

export async function saveMessage(senderId, receiverId, content) {
  const result = await db.prepare(`
    INSERT INTO messages (sender_id, receiver_id, content)
    VALUES (?, ?, ?)
  `).run(senderId, receiverId, content);

  return getMessageById(result.lastInsertRowid);
}

export async function getMessageById(id) {
  return db.prepare(`
    SELECT
      m.id,
      m.sender_id,
      sender.username AS sender_username,
      m.receiver_id,
      receiver.username AS receiver_username,
      m.content,
      m.delivered_at,
      m.read_at,
      m.created_at
    FROM messages m
    JOIN users sender ON sender.id = m.sender_id
    JOIN users receiver ON receiver.id = m.receiver_id
    WHERE m.id = ?
  `).get(id);
}

export async function getConversation(userA, userB) {
  return db.prepare(`
    SELECT
      m.id,
      m.sender_id,
      sender.username AS sender_username,
      m.receiver_id,
      receiver.username AS receiver_username,
      m.content,
      m.delivered_at,
      m.read_at,
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

export async function markMessagesDeliveredForConversation(receiverId, senderId) {
  return db.prepare(`
    UPDATE messages
    SET delivered_at = CURRENT_TIMESTAMP
    WHERE sender_id = ? AND receiver_id = ? AND delivered_at IS NULL
  `).run(senderId, receiverId);
}

export async function markMessagesReadForConversation(receiverId, senderId) {
  return db.prepare(`
    UPDATE messages
    SET
      read_at = CURRENT_TIMESTAMP,
      delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP)
    WHERE sender_id = ? AND receiver_id = ? AND read_at IS NULL
  `).run(senderId, receiverId);
}

export async function markMessageDeliveredById(messageId, receiverId) {
  return db.prepare(`
    UPDATE messages
    SET delivered_at = CURRENT_TIMESTAMP
    WHERE id = ? AND receiver_id = ? AND delivered_at IS NULL
  `).run(messageId, receiverId);
}

export async function savePushSubscription(userId, subscription) {
  const subscriptionJson = JSON.stringify(subscription);

  await db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, subscription_json)
    VALUES (?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id,
      subscription_json = excluded.subscription_json
  `).run(userId, subscription.endpoint, subscriptionJson);
}

export async function getPushSubscriptionsForUser(userId) {
  const rows = await db.prepare(`
    SELECT id, subscription_json
    FROM push_subscriptions
    WHERE user_id = ?
  `).all(userId);

  return rows.map((row) => ({
    id: row.id,
    subscription: JSON.parse(row.subscription_json)
  }));
}

export async function deletePushSubscription(id) {
  await db.prepare(`
    DELETE FROM push_subscriptions
    WHERE id = ?
  `).run(id);
}
