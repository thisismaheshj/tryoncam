import { config } from '../config.js';
import {
  type BillingResult,
  ProviderError,
  type ProviderCapabilities,
  type ProviderStatus,
  type SessionGrant,
  type SessionRequest,
  type TryOnProvider,
} from './types.js';

/**
 * Vidu S2-Editing adapter.
 *
 * Session creation is implemented against the shapes verified in Phase 0
 * (see docs/VIDU-API-NOTES.md). The control WebSocket is NOT yet wired, and
 * that is why this provider reports itself unimplemented.
 *
 * This is a deliberate safety gate, not an oversight. With Vidu there is no
 * REST endpoint that ends a session — hangup is exclusively WebSocket signal
 * type 5, sent by whoever holds the socket. Creating sessions without owning
 * that socket would mean no way to stop the meter, which is exactly the
 * failure mode the budget guardrails exist to prevent. Session creation
 * itself is free (billing starts at conn_init_ack), so nothing is lost by
 * refusing until the socket is in place.
 */
export class ViduProvider implements TryOnProvider {
  readonly id = 'vidu' as const;
  readonly displayName = 'Vidu — S2-Editing';
  readonly model = 'virtual_tryon';
  readonly usdPerSecond = config.vidu.usdPerSecond;
  /** No minimum documented for S2-Editing. */
  readonly minSessionSeconds = 1;

  readonly capabilities: ProviderCapabilities = {
    // switch_prompt (WS type 13), not billed separately.
    midSessionSwap: true,
    // The cap is ours to enforce by holding the socket; Vidu does not take
    // a maximum duration at creation time.
    providerEnforcedCap: false,
    // GET /live/v1/lives/{id} returns billed_seconds and credits_cost.
    reportsBilledSeconds: true,
  };

  status(): ProviderStatus {
    if (config.vidu.apiKey === '') {
      return {
        configured: false,
        implemented: false,
        detail: 'No VIDU_API_KEY set, and the control WebSocket is not wired yet.',
      };
    }
    return {
      configured: true,
      implemented: false,
      detail:
        'Key present, but the control WebSocket (conn_init / hangup) is not wired yet. ' +
        'Refusing to create sessions we could not stop.',
    };
  }

  async createSession(request: SessionRequest): Promise<SessionGrant> {
    const status = this.status();
    if (!status.implemented) throw new ProviderError(status.detail, 503);
    if (!status.configured) throw new ProviderError(status.detail, 503);

    const response = await fetch(`https://${config.vidu.host}/live/s_editing/realtime`, {
      method: 'POST',
      headers: {
        // Vidu's own docs contradict each other on the prefix; the working
        // reference proxy uses "Token ". See docs/AUTH-PROBE.md.
        Authorization: `Token ${config.vidu.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image_url: request.garmentUrl, editing_type: 'virtual_tryon' }),
      signal: AbortSignal.timeout(60_000),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new ProviderError(`Vidu session create failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
    }

    const data = JSON.parse(text) as {
      live?: { id?: string };
      rtc?: Record<string, string>;
      render_uid?: string;
    };
    // live.id is an int64 — it must stay a string or later queries break.
    if (typeof data.live?.id !== 'string' || !data.rtc?.token || !data.render_uid) {
      throw new ProviderError('Vidu response missing live.id (string), rtc credentials, or render_uid.');
    }

    return {
      transport: 'vidu-alirtc',
      provider: 'vidu',
      sessionId: request.sessionId,
      liveId: data.live.id,
      rtc: {
        appId: data.rtc.app_id ?? '',
        channelId: data.rtc.channel_id ?? '',
        userId: data.rtc.user_id ?? '',
        token: data.rtc.token,
        tokenExpireAt: data.rtc.token_expire_at ?? '',
      },
      renderUid: data.render_uid,
      maxSessionSeconds: request.maxSessionSeconds,
      garmentUrl: request.garmentUrl,
    };
  }

  /** Reads the authoritative billing figures once the session has ended. */
  async endSession(_sessionId: string, grant: SessionGrant | null): Promise<BillingResult> {
    if (!grant || grant.transport !== 'vidu-alirtc') {
      return { billedSeconds: null, estimated: true, note: 'No Vidu grant on record.' };
    }
    try {
      const response = await fetch(
        `https://${config.vidu.host}/live/v1/lives/${encodeURIComponent(grant.liveId)}`,
        {
          headers: { Authorization: `Token ${config.vidu.apiKey}` },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) {
        return { billedSeconds: null, estimated: true, note: `Billing query returned HTTP ${response.status}.` };
      }
      const data = (await response.json()) as { live?: { billed_seconds?: number } };
      const billed = data.live?.billed_seconds;
      return typeof billed === 'number'
        ? { billedSeconds: billed, estimated: false }
        : { billedSeconds: null, estimated: true, note: 'Response contained no billed_seconds.' };
    } catch (error) {
      return { billedSeconds: null, estimated: true, note: `Billing query failed: ${String(error)}` };
    }
  }
}
