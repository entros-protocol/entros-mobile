// Bootstrap polyfills required by Solana web3, ZK proving, and Poseidon salting.
// Imported as line 1 of index.ts so it runs before any module that touches `crypto` or
// `@solana/web3.js`. Order matters: getRandomValues must register before any consumer
// reads `crypto.getRandomValues`. Buffer + quick-crypto land at Stage 3.
import "react-native-get-random-values";
