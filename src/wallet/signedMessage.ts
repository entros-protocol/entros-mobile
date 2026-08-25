import { ed25519 } from "@noble/curves/ed25519";

const ED25519_SIGNATURE_BYTES = 64;

/** Extract and verify the signature suffix returned by MWA signMessages. */
export function extractVerifiedMessageSignature(
  message: Uint8Array,
  signedPayload: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array {
  if (publicKey.length !== 32) throw new Error("Wallet public key must be 32 bytes.");
  if (signedPayload.length !== message.length + ED25519_SIGNATURE_BYTES) {
    throw new Error("Wallet returned a malformed signed message payload.");
  }
  for (let index = 0; index < message.length; index++) {
    if (signedPayload[index] !== message[index]) {
      throw new Error("Wallet changed the validation message before signing.");
    }
  }
  const signature = signedPayload.slice(message.length);
  if (!ed25519.verify(signature, message, publicKey)) {
    throw new Error("Wallet returned an invalid validation signature.");
  }
  return signature;
}
