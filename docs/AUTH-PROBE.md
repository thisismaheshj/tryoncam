# Zero-Cost Auth Probe

**Run this the moment you have an API key — before writing any Phase 1 code.**

## Why

Vidu's own docs contradict each other on the auth header:

- The [S2-Editing parameters page](https://platform.vidu.com/vidu-stream/doc/s2-editing/parameters) says `Authorization: vda_<your_api_key>`, explicitly *"without the Token prefix"*.
- The overview, the S1 docs, and the **working** `node-quickstart` proxy all send `Authorization: Token vda_xxx`.

One of these is stale. Guessing wrong costs a confusing `401` during Phase 2, exactly when you are also debugging RTC and burning credits.

## Why it is free

Billing starts **only** when the WebSocket returns `conn_init_ack.success = true`. This probe:

- sends a `GET`, which creates nothing
- opens no WebSocket, so never reaches `conn_init`
- joins no RTC channel

**Cost: $0.00.** It cannot start a billing window.

## The probe

Set your key and region first:

```bash
export VIDU_KEY="vda_your_key_here"
export VIDU_HOST="api.vidu.com"   # or api.vidu.cn for a China key
```

Then run both forms against a deliberately non-existent session ID:

```bash
echo "--- Form A: with 'Token ' prefix ---"
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Token $VIDU_KEY" \
  "https://$VIDU_HOST/live/v1/lives/1"

echo "--- Form B: bare key, no prefix ---"
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: $VIDU_KEY" \
  "https://$VIDU_HOST/live/v1/lives/1"
```

## Reading the result

The session ID `1` does not exist, so **authentication is what varies**:

| Result | Meaning |
|---|---|
| `401` | Auth **rejected** — this form is wrong |
| `404` / `400` | Auth **accepted**, session merely not found — **this form is correct** |
| Both `401` | Key invalid, or **wrong region** (a `.cn` key on `.com` is rejected, and vice versa) |
| Both non-`401` | Either works; keep `Token` for consistency with the reference proxy |

Record the winner in `DECISIONS.md` and use it everywhere.

## If both return 401

Check region before anything else — it is the most common cause:

```bash
# Try the other region with the same key
curl -s -o /dev/null -w "vidu.cn  -> HTTP %{http_code}\n" \
  -H "Authorization: Token $VIDU_KEY" "https://api.vidu.cn/live/v1/lives/1"
curl -s -o /dev/null -w "vidu.com -> HTTP %{http_code}\n" \
  -H "Authorization: Token $VIDU_KEY" "https://api.vidu.com/live/v1/lives/1"
```

Still `401` on both regions and both forms means the key itself is bad — regenerate it in the console.

## Bonus: confirm your balance before Phase 2

Once auth is settled, the same endpoint family reports `billed_seconds` and `credits_cost` for real sessions — the authoritative figures the Phase 1 ledger reconciles against. Session creation also fails with a `400` `CreditInsufficient` if the balance is below the minimum, so a failed create is itself a free balance check.
