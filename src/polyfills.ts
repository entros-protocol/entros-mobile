// Bootstrap polyfills required by Solana web3 + Anchor SDK. Imported as
// line 1 of index.ts so it runs before any module that touches `crypto`
// or @solana/web3.js. Order matters: getRandomValues must register before
// any consumer reads `crypto.getRandomValues`; Buffer must register
// before @coral-xyz/anchor's BorshCoder constructs encoders.
import "react-native-get-random-values";
import { Buffer } from "buffer";

// Hermes ships no Buffer global; @coral-xyz/anchor's BorshCoder + the Vec<u8>
// encoders inside `verifyProof(...)` need one. Idempotent — safe if the
// runtime later gains a native Buffer.
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}
