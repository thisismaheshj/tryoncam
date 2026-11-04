# Real-Time Virtual Try-On — Smoke Test

Provider-agnostic backend and admin panel for testing real-time AI virtual try-on, with hard budget guardrails.

**Status:** backend, provider abstraction, Decart adapter and admin panel are built and tested. **No real API call has been made yet** — no credits have been spent.

| Provider | State | Rate | Budget |
|---|---|---|---|
| **Decart** — Lucy VTON 3.5 | Implemented, needs a key | $0.02/sec | 300s ≈ $6 |
| **Vidu** — S2-Editing | Gated off (see below) | $0.005/sec | 2400s ≈ $12 |

## Adding your Decart key

**Do not paste the key into chat.** Put it in `.env` yourself — it is gitignored and never leaves your machine:

```bash
echo 'DECART_API_KEY=dct_your_real_key' >> .env
```

Then restart the server. The admin panel greys out any provider without a key, so you will see it go live.

## Running

```bash
npm install && npm run dev
```

The panel is at **http://localhost:8787/admin**. `npm run dev` rebuilds the browser SDK bundle first.

## Guardrails

Five layers, each independent:

1. **Provider-enforced cap** — every Decart token carries `constraints.realtime.maxSessionDuration`. Decart refuses to stream past it regardless of what the client does.
2. **Reservation accounting** — a session's worst-case cost is held against the budget at mint time, so simultaneous requests cannot both slip through an apparently empty budget.
3. **Per-provider budget** — the ledger refuses to mint once cumulative billed seconds pass the ceiling.
4. **Concurrency counter** — enforced in the backend, never by trusting the client.
5. **Kill switch** — refuses all minting, both providers, and outranks every other check.

Plus a sweeper that reclaims abandoned leases every 5 seconds, charging the full grant for any session that had gone live.

```bash
npm test        # 26 tests, all on the budget and concurrency logic
npm run typecheck
```

## Why Vidu is gated off

`ViduProvider` is written against the verified Phase 0 shapes, but reports `implemented: false` and the server refuses to select it.

Vidu has **no REST endpoint to end a session** — hangup is WebSocket signal type 5, sent by whoever holds the socket. Until the backend owns that socket, any session created is one we cannot stop. Creating a Vidu session is free (billing starts at `conn_init_ack`), so nothing is lost by waiting.

To finish it: hold the upstream WS in the backend, send `conn_init`, wait for `conn_init_ack.success`, then `markStarted`; send type 5 on release. `docs/VIDU-API-NOTES.md` has every shape and error code.

## Layout

```
src/
  config.ts              env parsing; runtime holds the mutable provider + kill switch
  ledger.ts              append-only JSON Lines, budget totals
  budget.ts              SessionGuard — reservations, concurrency, sweeping
  providers/
    types.ts             the interface both adapters implement
    decart.ts            mints scoped ek_ tokens
    vidu.ts              S2-Editing; gated until the control socket exists
  server.ts              routes + static mounts
public/admin/            shared UI — same modules mount in the extension later
  api.js                 backend client, no same-origin assumption
  tryon.js               provider-agnostic stream controller
  panel.js               UI wiring
test/                    budget + provider-config tests
docs/VIDU-API-NOTES.md   Phase 0 research
DECISIONS.md             architectural decisions and why
```

## API

| Route | Purpose |
|---|---|
| `GET /api/state` | Everything the panel renders |
| `GET /api/budget` | Remaining seconds and dollars for the active provider |
| `POST /api/admin/provider` | Switch provider (refuses unavailable ones) |
| `POST /api/admin/kill-switch` | Toggle the kill switch |
| `POST /api/session` | Mint a session; checks guard **before** calling any provider |
| `POST /api/session/:id/started` | Client reports the billing clock started |
| `POST /api/session/:id/extend` | +15s, budget permitting |
| `POST /api/session/:id/end` | End, reconcile billing, write the ledger |
| `GET /api/garment?url=` | Server-side image fetch, dodging CORS and hotlink blocks |

## Cost reality

Decart bills per second of stream. 1,000 credits ≈ $10 ≈ **500 seconds ≈ 33 sessions** at the 15s cap.

Confirm the credit→USD rate on your dashboard — public pricing quotes USD/sec directly, and if 1 credit = $0.02 the balance is half that.

Garment swaps are free on both providers and need no reconnect, so **one session can evaluate several garments**. That is the cheapest way to run the quality matrix.
