import path from 'node:path';
import { FileStore } from './file.js';
import { RedisStore } from './redis.js';
import type { Store } from './types.js';

export type { Lease, ReserveRequest, ReserveResult, Store } from './types.js';

/**
 * Redis when it is configured, files otherwise.
 *
 * Deliberately implicit: local development should not need Redis, and a
 * serverless deployment must never silently fall back to files — which is why
 * `requireDurable` exists for the server to assert on boot.
 */
let instance: Store | null = null;

export function getStore(): Store {
  if (instance) return instance;
  const url = (process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? '').trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? '').trim();

  instance = url && token
    ? new RedisStore(url, token)
    : new FileStore(
        path.resolve(process.cwd(), process.env.LEDGER_PATH ?? 'data/ledger.jsonl'),
        path.resolve(process.cwd(), process.env.SETTINGS_PATH ?? 'data/settings.json'),
      );
  return instance;
}

/** Test seam. */
export function setStore(store: Store | null): void {
  instance = store;
}

/**
 * Serverless has no shared memory and no disk, so a FileStore there means the
 * ledger evaporates and — far worse — the concurrency and budget guards stop
 * working while still reporting success. Fail loudly at boot instead.
 */
export function assertDurableIfServerless(): void {
  const serverless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  if (serverless && getStore().kind !== 'redis') {
    throw new Error(
      'Running serverless without Redis: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. ' +
        'A file store cannot enforce the budget or concurrency limits here.',
    );
  }
}
