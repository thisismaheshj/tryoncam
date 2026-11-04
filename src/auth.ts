import type { JsonWebKey as NodeJsonWebKey } from 'node:crypto';
import { createHmac, createPublicKey, randomUUID, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { config } from './config.js';
import { readSettings } from './settings.js';

/**
 * Google sign-in, verified in-process against Google's published keys.
 *
 * No library: an ID token is a signed JWT, and Node can verify RS256 against a
 * JWK directly. Fewer dependencies in the path that decides who gets in.
 *
 * Auth is OFF until a client ID is configured. Turning it on by default would
 * lock the operator out of their own dashboard the moment they pulled this
 * change, before they had created anything in Google Cloud.
 */

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

export type GoogleUser = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture: string;
};

/** Client IDs may come from .env or from the dashboard; either turns auth on. */
export function clientIds(): string[] {
  const stored = readSettings().auth;
  return [...config.auth.clientIds, stored.webClientId, stored.extensionClientId]
    .map((id) => id.trim())
    .filter((id, index, all) => id !== '' && all.indexOf(id) === index);
}

export function authConfigured(): boolean {
  return clientIds().length > 0;
}

/**
 * Operators, as opposed to customers.
 *
 * Anyone with a Google account may sign in to the extension and buy credits;
 * only these addresses may open the dashboard. .env and the dashboard's own
 * list are additive. An empty list admits nobody — the opposite of the old
 * rule, which was written when the only person signing in was the operator and
 * "empty means anyone" was harmless.
 */
export function isAdmin(email: string): boolean {
  const admins = [...config.auth.adminEmails, ...readSettings().auth.allowedEmails];
  return admins.includes(email.toLowerCase());
}

// --- JWKS -------------------------------------------------------------------

type Jwk = { kid: string; n: string; e: string; kty: string; alg?: string };
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

async function jwks(): Promise<Jwk[]> {
  // Google rotates these; an hour is well inside their cache headers.
  if (jwksCache && Date.now() - jwksCache.fetchedAt < 3_600_000) return jwksCache.keys;
  const response = await fetch(JWKS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Could not fetch Google's signing keys (HTTP ${response.status}).`);
  const body = (await response.json()) as { keys: Jwk[] };
  jwksCache = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

const b64url = (input: string): Buffer => Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Verifies a Google ID token and returns its subject.
 *
 * Checks signature, issuer, audience and expiry. Skipping any one of these
 * turns "signed by Google" into "signed by Google for somebody else's app".
 */
export async function verifyIdToken(token: string, options: { nonce?: string } = {}): Promise<GoogleUser> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed ID token.');
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  let header: { kid?: string; alg?: string };
  try {
    header = JSON.parse(b64url(rawHeader).toString()) as { kid?: string; alg?: string };
  } catch {
    // A decode failure is not worth relaying verbatim — it leaks bytes and
    // tells the caller nothing they can act on.
    throw new Error('Malformed ID token.');
  }
  if (header.alg !== 'RS256') throw new Error(`Unexpected token algorithm: ${header.alg}`);

  const key = (await jwks()).find((candidate) => candidate.kid === header.kid);
  if (!key) throw new Error('Token was signed with a key Google does not publish.');

  const publicKey = createPublicKey({ key: key as unknown as NodeJsonWebKey, format: 'jwk' });
  const ok = verifySignature(
    'RSA-SHA256',
    Buffer.from(`${rawHeader}.${rawPayload}`),
    publicKey,
    b64url(rawSignature),
  );
  if (!ok) throw new Error('ID token signature did not verify.');

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64url(rawPayload).toString()) as Record<string, unknown>;
  } catch {
    throw new Error('Malformed ID token.');
  }
  if (!ISSUERS.has(String(payload.iss))) throw new Error(`Unexpected issuer: ${payload.iss}`);
  if (!clientIds().includes(String(payload.aud))) {
    throw new Error('ID token was issued for a different application.');
  }
  if (Number(payload.exp) * 1000 < Date.now()) throw new Error('ID token has expired.');
  // The extension asks for the token with a nonce of its own choosing; a token
  // captured from some other sign-in cannot carry it.
  if (options.nonce !== undefined && payload.nonce !== options.nonce) {
    throw new Error('ID token nonce did not match this sign-in.');
  }

  const email = String(payload.email ?? '').toLowerCase();
  if (!email) throw new Error('ID token carried no email.');

  return {
    sub: String(payload.sub),
    email,
    emailVerified: payload.email_verified === true,
    name: String(payload.name ?? email),
    picture: String(payload.picture ?? ''),
  };
}

// --- Sessions ---------------------------------------------------------------

/**
 * Stateless signed cookie: HMAC over the payload with the server secret.
 *
 * Deliberately not a session store — there is nothing to invalidate in a
 * single-operator smoke test, and a store is one more thing to get wrong.
 */
export function issueSessionToken(user: GoogleUser): string {
  const payload = Buffer.from(
    JSON.stringify({
      t: 'session', sub: user.sub, email: user.email, name: user.name, picture: user.picture,
      exp: Date.now() + config.auth.sessionTtlMs,
    }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function readSessionToken(token: string | undefined): GoogleUser | null {
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as GoogleUser & { exp: number; t?: string };
    // Both token kinds are signed with the same key, so the type is what stops
    // a password-gate cookie being replayed as somebody's sign-in.
    if (data.t !== 'session' || typeof data.sub !== 'string' || typeof data.email !== 'string') return null;
    if (data.exp < Date.now()) return null;
    return { sub: data.sub, email: data.email, emailVerified: true, name: data.name, picture: data.picture };
  } catch {
    return null;
  }
}

function sign(payload: string): string {
  return createHmac('sha256', config.auth.sessionSecret).update(payload).digest('base64url');
}

/** Regenerated per boot when unset, so an unconfigured install is never signing with a known constant. */
export const generatedSecret = randomUUID();

// --- Shared-password gate ----------------------------------------------------

/**
 * A cookie for the interim shared password, so the browser does not have to
 * resend it on every request and the dashboard can own the sign-in screen.
 *
 * The cookie never carries the password: it is an HMAC over a fingerprint of
 * it, which means changing DASHBOARD_PASSWORD silently invalidates every
 * cookie minted under the old one.
 */
export function issueGateToken(password: string): string {
  const payload = Buffer.from(
    JSON.stringify({ t: 'gate', g: fingerprint(password), exp: Date.now() + config.auth.sessionTtlMs }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function readGateToken(token: string | undefined, password: string): boolean {
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  const a = Buffer.from(signature);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { t?: string; g?: string; exp?: number };
    if (data.t !== 'gate' || Number(data.exp) < Date.now()) return false;
    return data.g === fingerprint(password);
  } catch {
    return false;
  }
}

function fingerprint(password: string): string {
  return createHmac('sha256', 'vton-gate').update(password).digest('base64url').slice(0, 16);
}
