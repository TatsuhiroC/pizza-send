import { sha256 } from '@noble/hashes/sha2.js';
import { createSHA256 } from 'hash-wasm';

export interface FileHash {
  update(bytes: Uint8Array): void;
  digest(): Uint8Array;
}

// Only accelerate the receiver: faster sender hashing caused transport stalls
// in repeated comparisons. Keep the established sender/checkpoint path intact.
export async function createFileHash(): Promise<FileHash> {
  try {
    const hash = await createSHA256();
    return {
      update: bytes => { hash.update(bytes); },
      digest: () => hash.digest('binary')
    };
  } catch {
    // Restricted/older browsers retain the existing streaming JS checksum.
    const hash = sha256.create();
    return { update: bytes => { hash.update(bytes); }, digest: () => hash.digest() };
  }
}
