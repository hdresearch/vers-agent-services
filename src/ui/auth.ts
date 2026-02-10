import { ulid } from "ulid";

export interface MagicLink {
  token: string;
  expiresAt: string;
  used: boolean;
}

export interface Session {
  id: string;
  createdAt: number;
  expiresAt: number;
}

const MAGIC_LINK_TTL = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

const magicLinks = new Map<string, MagicLink>();
const sessions = new Map<string, Session>();

export function createMagicLink(): MagicLink {
  const token = ulid() + ulid(); // long random token
  const link: MagicLink = {
    token,
    expiresAt: new Date(Date.now() + MAGIC_LINK_TTL).toISOString(),
    used: false,
  };
  magicLinks.set(token, link);
  return link;
}

export function consumeMagicLink(token: string): boolean {
  const link = magicLinks.get(token);
  if (!link) return false;
  if (link.used) return false;
  if (new Date(link.expiresAt).getTime() < Date.now()) {
    magicLinks.delete(token);
    return false;
  }
  link.used = true;
  magicLinks.delete(token);
  return true;
}

export function createSession(): Session {
  const id = ulid();
  const now = Date.now();
  const session: Session = {
    id,
    createdAt: now,
    expiresAt: now + SESSION_TTL,
  };
  sessions.set(id, session);
  return session;
}

export function validateSession(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}

// Cleanup expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of magicLinks) {
    if (new Date(v.expiresAt).getTime() < now) magicLinks.delete(k);
  }
  for (const [k, v] of sessions) {
    if (v.expiresAt < now) sessions.delete(k);
  }
}, 60_000);
