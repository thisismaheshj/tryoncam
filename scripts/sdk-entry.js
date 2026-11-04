// Browser entry for the Decart SDK.
//
// The published dist is unbundled ESM with bare specifiers (zod, mitt,
// p-retry, livekit-client), which no browser can resolve on its own. Bundling
// it here serves both mounts: the localhost admin panel today, and the MV3
// extension later, where remote scripts are forbidden outright.
//
// `createConsoleLogger` is exported so callers can raise the SDK's log level.
// Its default is "warn", and its own teardown logs "room disconnected" and
// "websocket closed" at that level — which Chrome files under Errors.
export { createDecartClient, createConsoleLogger, noopLogger, models } from '@decartai/sdk';
