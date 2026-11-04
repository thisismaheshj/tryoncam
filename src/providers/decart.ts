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
 * Decart adapter.
 *
 * The browser talks to Decart directly over WebRTC (LiveKit-backed), so this
 * adapter's whole job is minting a client token that is too narrow to be
 * worth stealing: one model, one origin, one duration.
 *
 * `constraints.realtime.maxSessionDuration` is the important field. It is
 * enforced by Decart, not by us, so a session cannot outlive its cap even if
 * the browser is compromised, the window is closed, or our backend dies.
 * That is a stronger guarantee than a client-side timer can offer.
 */
export class DecartProvider implements TryOnProvider {
  readonly id = 'decart' as const;
  readonly displayName = 'Decart — Lucy VTON';
  // Read on every use rather than captured at construction: the price can be
  // changed from the dashboard while the process keeps running.
  get model(): string {
    return config.decart.model;
  }
  get usdPerSecond(): number {
    return config.decart.usdPerSecond;
  }
  /**
   * Verified against the live API: a mint with maxSessionDuration below 10
   * is rejected with "Too small: expected number to be >=10".
   */
  readonly minSessionSeconds = 10;

  readonly capabilities: ProviderCapabilities = {
    midSessionSwap: true,
    providerEnforcedCap: true,
    // Decart bills per second of stream; there is no per-session billing
    // read-back endpoint, so our own clock is the source of truth.
    reportsBilledSeconds: false,
  };

  status(): ProviderStatus {
    if (config.decart.apiKey === '' || config.decart.apiKey.includes('your_key_here')) {
      return {
        configured: false,
        implemented: true,
        detail: 'Set DECART_API_KEY in .env (server-side only) and restart.',
      };
    }
    return { configured: true, implemented: true, detail: `Ready — ${this.model} at $${this.usdPerSecond}/sec.` };
  }

  async createSession(request: SessionRequest): Promise<SessionGrant> {
    const status = this.status();
    if (!status.configured) throw new ProviderError(status.detail, 503);

    const body: Record<string, unknown> = {
      // Only long enough to connect. The session's own cap is separate.
      expiresIn: config.session.connectWindowSeconds,
      allowedModels: [this.model],
      constraints: {
        realtime: { maxSessionDuration: Math.max(this.minSessionSeconds, request.maxSessionSeconds) },
      },
      metadata: { sessionId: request.sessionId, app: 'vton-smoke-test' },
    };
    // Origin locking is enforced by matching the WebSocket Origin header
    // verbatim, so only send it when we actually have one.
    if (request.allowedOrigin) body.allowedOrigins = [request.allowedOrigin];

    const response = await fetch(`${config.decart.baseUrl}/v1/client/tokens`, {
      method: 'POST',
      headers: {
        // Verified against the Decart SDK's buildAuthHeaders: the platform
        // uses X-API-KEY, not an Authorization bearer token.
        'X-API-KEY': config.decart.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new ProviderError(
        `Decart token mint failed (HTTP ${response.status}): ${text.slice(0, 300)}`,
        response.status === 401 || response.status === 403 ? 502 : response.status,
      );
    }

    let parsed: { apiKey?: string; expiresAt?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProviderError('Decart returned a token response that was not JSON.');
    }
    if (!parsed.apiKey) {
      throw new ProviderError('Decart token response contained no apiKey.');
    }

    return {
      transport: 'decart-livekit',
      provider: 'decart',
      sessionId: request.sessionId,
      clientToken: parsed.apiKey,
      model: this.model,
      expiresAt: parsed.expiresAt ?? '',
      maxSessionSeconds: request.maxSessionSeconds,
      prompt: request.prompt,
      enhance: request.enhance === true,
      garmentUrl: request.garmentUrl,
    };
  }

  /**
   * Nothing to call. The browser disconnects, and Decart's own
   * `maxSessionDuration` is the backstop. Billing is therefore whatever our
   * clock measured — flagged as estimated so the ledger never overstates its
   * own confidence.
   */
  async endSession(): Promise<BillingResult> {
    return {
      billedSeconds: null,
      estimated: true,
      note: 'Decart exposes no per-session billing read-back; seconds measured locally.',
    };
  }
}
