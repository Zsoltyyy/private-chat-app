import jwt from "jsonwebtoken";
import { findUserById } from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_this";

export function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      is_admin: Boolean(user.is_admin)
    },
    JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || "7d"
    }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;

  if (!header) {
    return res.status(401).json({ error: "Hiányzó token." });
  }

  const [type, token] = header.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ error: "Érvénytelen token formátum." });
  }

  try {
    const payload = verifyToken(token);
    const user = await findUserById(payload.id);

    if (!user) {
      return res.status(401).json({ error: "Érvénytelen vagy lejárt token." });
    }

    req.user = {
      ...payload,
      ...user,
      is_admin: Boolean(user.is_admin)
    };
    next();
  } catch {
    return res.status(401).json({ error: "Érvénytelen vagy lejárt token." });
  }
}
