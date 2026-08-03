/**
 * timeflare-sdk — the single TypeScript client for the Timeflare protocol.
 *
 * One component: generated protobuf types, REST + cosmjs chain access,
 * constants, creator + recipient flows, and crypto behind a CryptoProvider
 * interface with backends compiled from the one Rust crate (WASM here for
 * web/Node; JSI in the mobile build). Consumers — including the mobile
 * client — use this package; nothing duplicates what it does.
 *
 * Transport: grpc-gateway REST for module queries, cosmjs for tx signing.
 */

export * from './blockclock';
export * from './constants';
export * from './crypto';
export * from './conventions';
export * from './rest';
export * from './txclient';
export * from './wallet';
export * from './watch';
export * from './session';
export * from './recipient';

// Re-export the generated protocol types callers commonly touch.
export type {
  SecretView,
  SecretAssignmentView,
  HintRecord,
} from '../generated/timeflare/secrets/v1/query';
export type {
  DetectionHint,
  RevealedShare,
  RevealWindow,
  // The slim record `secretMeta` returns — the shape every status surface
  // reads, and the one that carries no share bytes.
  Secret,
  SecretTombstone,
} from '../generated/timeflare/secrets/v1/secret';
export type { Guardian } from '../generated/timeflare/secrets/v1/guardian';
