import type { ProviderId } from '../config.js';
import { DecartProvider } from './decart.js';
import type { TryOnProvider } from './types.js';
import { ViduProvider } from './vidu.js';

const providers: Record<ProviderId, TryOnProvider> = {
  decart: new DecartProvider(),
  vidu: new ViduProvider(),
};

export function getProvider(id: ProviderId): TryOnProvider {
  return providers[id];
}

export function allProviders(): TryOnProvider[] {
  return Object.values(providers);
}
