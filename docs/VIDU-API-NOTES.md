# Vidu S2-Editing — Verified API Notes

**Phase 0 deliverable.** Researched 2026-09-22. Everything below is either **verified** against a primary source or explicitly labelled **UNVERIFIED / GUESS**.

## Sources

| Source | What it gave |
|---|---|
| [S2-Editing parameters](https://platform.vidu.com/vidu-stream/doc/s2-editing/parameters) | **Primary.** Request/response, full WS signal spec, error codes, billing window |
| [Vidu Live overview](https://platform.vidu.com/vidu-stream/doc) | Product matrix, integration conventions, pricing per product |
| [`lideang821/vidu-s1-api`](https://github.com/lideang821/vidu-s1-api) | **Working S2 code.** `examples/node-quickstart/server.js` (proxy), `public/editing.html` + `app.js` (client), `skills/vidu-s-api/references/` (HTTP + WS reference). MIT. |
| `aliyun-rtc-sdk` npm tarball | Static analysis for MV3 viability (see [AliRTC](#5-media-transport-alirtc)) |

> Note: the docs site is a JavaScript app. Plain HTTP fetches return an empty body — it must be read in a real browser. The repo, despite its `s1` name, now covers S2 for both Avatar and Editing.

## 0. Before Phase 1 — what you still need

You have no key and no credits yet. Required to proceed:

1. **Pick a region.** Keys are region-specific and a mismatched key returns `401`. Default in config: `VIDU_HOST=api.vidu.com` (matches your brief's $0.005/credit math).
   - Global: `api.vidu.com`, console at `platform.vidu.com/api-keys`
   - China: `api.vidu.cn`, console at `platform.vidu.cn/api-keys`
2. **Get a `vda_...` key** for that region.
3. **Top up credits.** Editing's minimum opening balance is undocumented (Avatar's is 45 credits).
4. **Run the auth probe** in [`AUTH-PROBE.md`](AUTH-PROBE.md) — costs $0.00 and settles the one contradiction below.

## 1. Create an S2-Editing session — VERIFIED

```
POST https://{host}/live/s_editing/realtime
```

### Headers

| Header | Value |
|---|---|
| `Authorization` | ⚠️ **Contradictory across docs — see [§8](#8-unverified--treat-as-guesses).** Use `Token vda_xxx`. |
| `Content-Type` | `application/json` |
| `X-Request-ID` | Optional, ≤36 chars, UUID recommended. Tracing only. |

### Request body

```json
{
  "image_url": "https://example.com/garment.png",
  "editing_type": "virtual_tryon"
}
```

| Field | Required | Notes |
|---|---|---|
| `image_url` | **Yes** | Three accepted forms — see [§2](#2-supplying-the-garment-image--verified) |
| `editing_type` | No | Defaults to `style_transfer`. **Use `virtual_tryon`.** |
| `rtmp_urls` | No | `string[]`, ≤5, each `rtmp://` and ≤2048 chars. Relays the composited result. **If relay fails to start, the session ends immediately** — leave it unset for this project. |

`editing_type` enum: `style_transfer` (default) · **`virtual_tryon`** · `subject_replacement` · `background_replacement`

Virtual try-on is a **first-class supported mode**, not a style-transfer workaround.

### Response

```json
{
  "live": {
    "id": "995200676634042368",
    "live_duration": 120,
    "status": "waiting",
    "call_mode": "video",
    "created_at": "1789025863",
    "trace_id": "d17ab29172bef09b3f093b169c233e67"
  },
  "rtc": {
    "app_id": "xxx",
    "channel_id": "xxx",
    "user_id": "xxx",
    "token": "xxx",
    "token_expire_at": "1789033063"
  },
  "render_uid": "xxx"
}
```

Three things to get right:

- **`render_uid` is essential.** It identifies the RTC user publishing the *edited output*. Any other participant's video is **not** the try-on result. Subscribe to this uid's camera stream and nothing else.
- **`live.id` is an int64 — keep it a string everywhere.** JSON number precision loss will silently break later queries. Applies to `live_id`, `task_id`, `stream_id`.
- **`live_duration` is per-session, read it at runtime.** The documented Editing example returns **120**, not the 600 assumed in the brief.

`client_secret` may also be returned: a short-lived WS credential for browsers (which cannot set WS headers). Validity matches `rtc.token_expire_at`. **Our backend owns the WebSocket, so this never leaves the server.** The reference proxy treats it as optional — do not assume it is present.

## 2. Supplying the garment image — VERIFIED

`image_url` (at creation) and `prompts[].content` (at switch) accept the **same three forms**:

| Form | Example | Notes |
|---|---|---|
| http(s) URL | `https://shop.com/tee.jpg` | Simplest path for the extension — product pages already give us one |
| base64 data URI | `data:image/png;base64,...` | Reference demo caps local files at 4 MB (~5.4 MB encoded). **WS messages cap at 16 MB.** |
| Platform upload URI | `ssupload:?id=...` | Via the upload endpoint; avoids re-upload cost for repeat garments |

For the extension, a direct product-image URL is the primary route. Base64 is the fallback when a site's images are hotlink-protected or behind auth — worth expecting, since some retailers block third-party fetches.

## 3. Changing the outfit mid-session — VERIFIED: YES

**This is the single most important finding for your cost model.**

WS signal `type: 13` swaps the garment **without reconnecting**, and **is not billed separately**:

```json
{
  "type": 13,
  "live_id": "995200676634042368",
  "conn_id": "conn-xxx",
  "seq_id": 2,
  "payload": {
    "switch_prompt": {
      "prompts": [{ "type": "image", "content": "https://example.com/new-garment.png" }],
      "editing_type": "virtual_tryon"
    }
  }
}
```

- At most **one** prompt, `type` must be `image`.
- Supply `prompts`, `editing_type`, or both. Omitted fields keep their current value. Neither → no-op.
- The picture switches **within a few seconds**.

### Three behavioural traps

1. **Success sends no acknowledgement.** Silence means it worked.
2. **The server does not deduplicate.** Sending twice switches twice.
3. Therefore: **never retry on missing ack.** Only `type: 14` (`success: false`) means failure; fix the request and resend with a **fresh `seq_id`**.

**Consequence:** one 15-second session can evaluate several garments at zero extra credit cost and with no per-garment warmup. Your Phase 5 quality matrix (solid tee / patterned dress / jacket / logo tee) becomes cheap to run back-to-back inside a single stream.

## 4. WebSocket control channel — VERIFIED

```
wss://{host}/live/ws/live/connect?live_id={live_id}&conn_id={conn_id}
Authorization: Token vda_xxx          # server-side (our design)

wss://{host}/live/ws/live/connect?live_id=..&conn_id=..&client_secret=..   # browser-side
```

- `conn_id` is client-generated, constant for the connection, and **must be reused when reconnecting**.
- **WS carries control signals only. All media goes over RTC.**
- Max message size: **16 MB**.

### Signal table

| Type | Direction | Payload | Used here |
|---|---|---|---|
| 1 | C→S | `conn_init` | ✅ |
| 2 | S→C | `conn_init_ack` | ✅ |
| 5 | C→S | `hangup` | ✅ |
| 6 | S→C | forced hangup | ✅ |
| 13 | C→S | `switch_prompt` | ✅ |
| 14 | S→C | `switch_prompt_ack` (**failure only**) | ✅ |
| 7 / 11 / 12 / 99 | — | Avatar-only (interrupt, `prompt_operation`, `text_msg`) | ❌ |

### Handshake — and where billing starts

Send `type: 1` **immediately** on open. A completed TCP/WS handshake is *not* readiness:

```json
{ "type": 1, "live_id": "995...", "conn_id": "conn-xxx", "seq_id": 1,
  "payload": { "conn_init": { "version": 1 } } }
```

The ack's `seq_id` is the request's **plus one**.

> **`conn_init_ack.success === true` is the billing start instant.** The stream enters `on_live` and the meter begins. This single fact drives the entire cost architecture — see [§7](#7-billing--verified).

On `error_code: NOT_READY` the renderer is warming up. **For Editing, keep waiting on the same socket** — the server pushes a success ack when ready (Avatar, by contrast, re-sends `conn_init` every 2–3s). Retries draw on a server-side budget; exhausting it ends the stream with `SIP_READY_TIMEOUT`. The reference demo bounds Editing startup at **120 seconds**.

### Hangup

```json
{ "type": 5, "live_id": "995...", "conn_id": "conn-xxx", "seq_id": 3,
  "payload": { "hangup": { "hangup_reason": "user_hangup" } } }
```

**There is no REST endpoint to end a session.** Hangup is exclusively this WS signal — which is precisely why the backend must own the socket.

Forced-hangup (`type: 6`) reasons include `timeout`, `credit_insufficient`, `audit_violation`, `provider_closed`. Treat a *missing* `type: 6` as normal; WS close/error is the fallback path. Guard against late callbacks from an ended session mutating live UI.

### Reconnection

An unexpected drop can be recovered **within a grace period** by reusing the same `live_id` **and** `conn_id`. Miss the window and the stream ends and billing stops. Grace period length is undocumented ([§8](#8-unverified--treat-as-guesses)).

### Lifecycle states

`waiting` → `prepared` → `on_live` *(billed)* → `ending` → `ended`

`close_reason` on the live object explains termination (e.g. concurrency limit exceeded, relay start failure).

## 5. Media transport: AliRTC

### Verified: the SDK bundles under MV3

Your Constraint 2 asked for an immediate answer. **It works.** Static analysis of the `aliyun-rtc-sdk` npm tarball:

```
package/dist/aliyun-rtc-sdk.es.js     1.3M   ES module
package/dist/aliyun-rtc-sdk.umd.js    1.0M   UMD
package/dist/plugins/…                       audioProcessPlugin, beautyPlugin
package/dist/types/index.d.ts         263K   TypeScript definitions
```

| MV3 hazard | Finding |
|---|---|
| `.wasm` files shipped | **None** |
| `importScripts` / remote script tags | **None** |
| `eval(` | **None** |
| `new Function` | **1** — inside `AudioAPM init`, wrapped in `try/catch` |
| Remote fetch | **1** — `g.alicdn.com/code/npm/@ali/aliyun-audio-3a/…`, audio 3A only |
| Telemetry | `arms-retcode*.aliyuncs.com/r.png` image beacons — non-functional |

**Both CSP hazards live exclusively on the audio path.** Virtual try-on publishes **video only** — no microphone — which sidesteps them entirely. No `wasm-unsafe-eval`, no `web_accessible_resources` entry, no remote code.

**Pin `aliyun-rtc-sdk@7.1.9`** (published 2025-10-31). Latest is 7.3.6, but 7.1.9 is the version the working demo and reference docs describe, and the 7.3.x API is not verified against them. Do not float this dependency.

### Verified: client sequence

1. Wait for `conn_init_ack.success === true`, **then** join RTC.
2. `joinChannel(rtc.token, rtc.user_id)` — pass the returned base64 credential directly. Vidu supplies the credentials; no AppKey or self-signed token.
3. Channel profile `communication`. Configure subscriptions **before** joining.
4. 7.1.9 has **no** `setDefaultPublishLocalAudioStream` / `setDefaultPublishLocalVideoStream` — use the `publishLocal*Stream` methods **after** joining.
5. Publish the camera as the editing input.
6. Bind remote video only when subscribe state is `3` (subscribed). `videoSubscribeStateChanged` ↔ camera stream type `1`.
7. **Render only `render_uid`'s camera stream.**
8. Join before `rtc.token_expire_at`. Release media on `authInfoExpired`, `type: 6`, or WS close. (`authInfoWillExpire` is advance warning — log it, keep the call running.)

## 6. Errors — VERIFIED

### HTTP

```json
{ "code": 400, "reason": "BAD_REQUEST", "message": "Invalid parameter", "metadata": {} }
```

| Status | Meaning |
|---|---|
| 400 | Bad `image_url` / `editing_type` / `rtmp_urls`, **or `CreditInsufficient`** |
| 401 | Bad key — **most often a region mismatch** |
| 429 | **Concurrent stream limit reached.** End a running stream first. |

Do not treat every 400 as auth failure — insufficient credits surfaces here too. `metadata.trace_id` goes to support.

### WebSocket

| `error_code` | Handling |
|---|---|
| `NOT_READY` | Warming up. Editing: keep waiting on the socket. |
| `SIP_READY_TIMEOUT` | Readiness budget exhausted, stream ended. Create a new one. |
| `LIVE_ENDED` / `LIVE_NOT_ACTIVE` | Stream gone. New session required. |
| `LIVE_CONN_INIT_FAILED` | Unclassified init failure. Retry, then escalate with `trace_id`. |
| `SWITCH_PROMPT_INVALID` | Bad switch params (missing both fields, bad image). |
| `SWITCH_PROMPT_EXPIRED` | Resend with a new `seq_id`. |
| `RENDER_NOT_READY` / `RENDER_WRITE_FAILED` / `SWITCH_PROMPT_TIMEOUT` | Transient. Retry. |
| `SWITCH_PROMPT_INTERNAL_ERROR` | Escalate with `trace_id`. |

## 7. Billing — VERIFIED

**1 credit per second.** Global $0.005/credit (your figure); the China docs quote CNY 0.03125/credit.

### The billing window

> **Starts:** the server returns `conn_init_ack.success = true` (stream enters `on_live`).
> **Ends:** the hangup signal ends the stream.

Explicitly **not billed**:

- Creating a session
- Opening the WebSocket alone
- Joining the RTC channel alone
- Renderer warm-up / `NOT_READY` waiting
- `switch_prompt` garment changes

This is far more forgiving than the brief assumed. A session that fails during warm-up costs **nothing**, so early Phase 2 debugging is close to free. Your $15 ≈ 3,000 credits ≈ **50 minutes of `on_live` time**, and only `on_live` time.

### Reading actual spend

```
GET https://{host}/live/v1/lives/{live_id}
```

Returns the live object including **`billed_seconds`** and **`credits_cost`** — the authoritative figures for the ledger. Call after the session ends, and reconcile against your own timing rather than trusting client-side counters.

### What this means for the guardrails

Because billing starts at a moment **the backend observes** (it owns the WS) and stops via a signal **only the backend can send**, the hard cap belongs on the server:

- A server timer armed at `conn_init_ack.success` and firing `type: 5` at the cap is **authoritative**.
- A client countdown is **cosmetic** — useful UX, not a guardrail.
- If the extension window is killed mid-stream, the backend still holds the socket and still hangs up. Your "leaked session bills until timeout" concern is **structurally eliminated**, not merely mitigated.

This supersedes Constraint 5's client-side cap. Keep the client countdown for UX; make the server the enforcer.

## 8. UNVERIFIED — treat as guesses

| Item | Status |
|---|---|
| **Auth header prefix** | ⚠️ **Genuine doc contradiction.** The S2-Editing parameters page states `Authorization: vda_<key>` *"without the Token prefix"*; the overview, S1 docs, and the working proxy all use `Authorization: Token vda_xxx`. **Recommendation: use `Token`** (it is what runnable code does), and settle it with [`AUTH-PROBE.md`](AUTH-PROBE.md) at $0.00 before Phase 1. |
| **"5 free concurrent, ~$2,080/mo each beyond"** | **Could not verify.** No public doc states either figure. Docs confirm only that `429` = concurrency limit and `close_reason` can cite it. **Your brief's numbers should be treated as unconfirmed.** Keep `MAX_CONCURRENT` configurable and low (1–2 for a single-user smoke test); the backend must enforce it regardless. |
| **Editing minimum balance** | Unknown. Avatar requires 45 credits. Editing surfaces `CreditInsufficient` as a 400. |
| **Max Editing session duration** | Example shows `live_duration: 120`; the overview cites 7200s for Avatar. **Not the 600s in the brief.** Read per-session at runtime. |
| **Reconnect grace period** | Documented as existing; length never stated. |
| **Heartbeat interval for Editing** | Avatar docs specify traffic within 15s. Editing unstated. Node `ws` auto-replies to pings. |
| **Latency, frame rate, resolution, garment fidelity** | **Nothing in the docs.** Phase 2 is the only way to know. |
| **Behaviour with no person in frame** | Undocumented. |

## 9. Go / no-go

**GO.** Every architectural risk flagged in the brief resolved in the project's favour. S2-Editing has a purpose-built `virtual_tryon` mode reached by a single documented endpoint; AliRTC ships as a pure-JS npm package with no wasm and no remote code on the video path, so the MV3 bundling question — the one you most wanted answered early — is settled **yes**, with video-only publishing as a clean mitigation for the audio-path CSP hazards. A complete, MIT-licensed reference proxy and Editing client already exist, reducing Phase 1 to *adding a ledger, a concurrency counter and a cap timer to proven code* rather than building from scratch. Three brief assumptions were wrong in helpful directions: billing starts at `conn_init_ack` rather than session creation (so warm-ups and failed attempts are free), garments swap mid-session via `switch_prompt` at no extra charge (so one 15s session tests several garments), and hangup is server-owned (so a killed extension window cannot leak a billing session).

**The biggest remaining unknown is the one no document can answer: latency and garment fidelity.** Time-to-first-transformed-frame decides whether the UX premise holds at all, and whether the output resembles *this* garment or merely similar clothing decides whether the product is worth anything. Both are Phase 2 measurements. Everything before that is now de-risked; I would not spend a credit on extension work until Phase 2 gives an honest read on those two numbers.

**Secondary risk:** the auth-prefix contradiction — cheap to settle, and free.
