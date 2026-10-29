// Public protocol entry; implementation modules import each other directly.
export { Transfer, bytes, validateManifest } from './transfer';
export type { FileInfo, Config, TransferEvent } from './transfer';
export { Signaling } from './signaling';
export { AutoPair, DIRECT_SWITCH_MS } from './auto-pair';
export { randomToken, packDescription, unpackDescription, signalKey, seal, unseal } from './protocol-codec';
export { safeName } from './file-name';
