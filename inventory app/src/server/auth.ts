// Team-member sign-in. Members and PINs live in the server environment (TEAM_MEMBERS="Ana:4821,Ben:9134").
// The browser receives an HMAC-signed token; no Google or catalog credential ever reaches the client.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Auth {
  members: Map<string, string>; // lowercased name -> pin
  displayNames: Map<string, string>;
  secret: Buffer;
  demoMembers: boolean;
}

export function authFromEnv(env: NodeJS.ProcessEnv = process.env): Auth {
  let raw = env.TEAM_MEMBERS ?? '';
  const demoMembers = !raw.trim();
  if (demoMembers) raw = 'Demo One:1111,Demo Two:2222';
  const members = new Map<string, string>();
  const displayNames = new Map<string, string>();
  for (const entry of raw.split(',')) {
    const i = entry.lastIndexOf(':');
    if (i <= 0) continue;
    const name = entry.slice(0, i).trim();
    members.set(name.toLowerCase(), entry.slice(i + 1).trim());
    displayNames.set(name.toLowerCase(), name);
  }
  const secret = env.SESSION_SECRET ? Buffer.from(env.SESSION_SECRET) : randomBytes(32);
  return { members, displayNames, secret, demoMembers };
}

const sig = (auth: Auth, payload: string) => createHmac('sha256', auth.secret).update(payload).digest('base64url');

export function login(auth: Auth, name: string, pin: string): string | undefined {
  const key = name.trim().toLowerCase();
  const expected = auth.members.get(key);
  if (!expected) return undefined;
  const a = Buffer.from(expected), b = Buffer.from(pin.trim());
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  const payload = `${Buffer.from(auth.displayNames.get(key)!).toString('base64url')}.${Date.now() + 1000 * 60 * 60 * 24 * 30}`;
  return `${payload}.${sig(auth, payload)}`;
}

/** Returns the member's display name, or undefined if the token is missing, forged, expired, or the member was removed. */
export function verify(auth: Auth, token: string | undefined): string | undefined {
  if (!token) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const payload = `${parts[0]}.${parts[1]}`;
  const good = Buffer.from(sig(auth, payload)), got = Buffer.from(parts[2]);
  if (good.length !== got.length || !timingSafeEqual(good, got)) return undefined;
  if (Number(parts[1]) < Date.now()) return undefined;
  const name = Buffer.from(parts[0], 'base64url').toString('utf8');
  return auth.members.has(name.toLowerCase()) ? name : undefined;
}
