import type { ProviderId } from '../config.js';

export type SessionRequest = {
  /** Our own session id. Passed to the provider as metadata where supported. */
  sessionId: string;
  /** Absolute URL of the garment image, already resolved by the caller. */
  garmentUrl: string;
  /** Free-text instruction. Providers differ in how much weight they give it. */
  prompt: string;
  /** Hard cap for this session, in seconds. */
  maxSessionSeconds: number;
  /** Let the model expand a short or vague prompt on its own. */
  enhance?: boolean;
  /** Browser origin to lock client credentials to, when the provider supports it. */
  allowedOrigin?: string | undefined;
};

/**
 * What the browser needs to open the stream. Deliberately a discriminated
 * union rather than a lowest-common-denominator shape: the two providers use
 * genuinely different transports, and flattening that would hide the very
 * difference this experiment exists to measure.
 */
export type SessionGrant =
  | {
      transport: 'decart-livekit';
      provider: 'decart';
      sessionId: string;
      /** Short-lived ek_ token. Scoped to one model, one origin, one duration. */
      clientToken: string;
      model: string;
      expiresAt: string;
      maxSessionSeconds: number;
      prompt: string;
      enhance: boolean;
      garmentUrl: string;
    }
  | {
      transport: 'vidu-alirtc';
      provider: 'vidu';
      sessionId: string;
      liveId: string;
      rtc: { appId: string; channelId: string; userId: string; token: string; tokenExpireAt: string };
      /** Only this RTC user's video is the edited result. */
      renderUid: string;
      maxSessionSeconds: number;
      garmentUrl: string;
    };

export type BillingResult = {
  /** Seconds the provider says it billed, or null when it cannot tell us. */
  billedSeconds: number | null;
  /** True when `billedSeconds` came from our clock rather than the provider. */
  estimated: boolean;
  note?: string;
};

export type ProviderCapabilities = {
  /** Can the garment be swapped without tearing down the session? */
  midSessionSwap: boolean;
  /** Is the hard cap enforced by the provider, or only by us? */
  providerEnforcedCap: boolean;
  /** Can the backend report exact billed seconds after the fact? */
  reportsBilledSeconds: boolean;
};

export type ProviderStatus = {
  configured: boolean;
  /** False when the adapter itself is incomplete, regardless of credentials. */
  implemented: boolean;
  detail: string;
};

export interface TryOnProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly model: string;
  readonly usdPerSecond: number;
  /** Shortest session the provider will accept. Decart rejects below 10s. */
  readonly minSessionSeconds: number;
  readonly capabilities: ProviderCapabilities;

  status(): ProviderStatus;

  /** Mints whatever the browser needs to open a stream. */
  createSession(request: SessionRequest): Promise<SessionGrant>;

  /** Stops the session if the provider allows it, and reports what it billed. */
  endSession(sessionId: string, grant: SessionGrant | null): Promise<BillingResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
