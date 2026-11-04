/**
 * Vercel serverless entry.
 *
 * Express is handed the request directly; Vercel's Node runtime passes
 * IncomingMessage/ServerResponse, which is exactly what an Express app is.
 *
 * `assertDurableIfServerless` runs on import, so a deployment missing its
 * Redis credentials fails immediately and loudly rather than quietly losing
 * the ledger and disabling the budget guard.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { app } from '../src/server.js';
import { refreshSettings } from '../src/settings.js';
import { assertDurableIfServerless } from '../src/store/index.js';

assertDurableIfServerless();
// Warm the settings cache while the first request is in flight. A failure
// here must be caught on the spot: a promise that rejects before anything
// awaits it is an unhandled rejection, and Node ends the whole process for it —
// which is how one slow Redis read on a cold start became a crashed function.
// The per-request middleware in server.ts reads settings again regardless.
const ready = refreshSettings().catch((error: unknown) => {
  console.error('[boot] settings warm-up failed; will retry per request:', error);
});

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await ready;
  return (app as unknown as (q: IncomingMessage, s: ServerResponse) => void)(req, res);
}
