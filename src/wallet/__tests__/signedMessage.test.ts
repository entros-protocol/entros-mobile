import { ed25519 } from "@noble/curves/ed25519";

import { extractVerifiedMessageSignature } from "../signedMessage";

describe("MWA signed message payload", () => {
  const privateKey = new Uint8Array(32).fill(9);
  const publicKey = ed25519.getPublicKey(privateKey);
  const message = new TextEncoder().encode("Entros validation request");
  const signature = ed25519.sign(message, privateKey);

  test("extracts and verifies the 64-byte suffix", () => {
    const signedPayload = new Uint8Array(message.length + signature.length);
    signedPayload.set(message);
    signedPayload.set(signature, message.length);
    expect(extractVerifiedMessageSignature(message, signedPayload, publicKey)).toEqual(signature);
  });

  test("rejects changed prefixes, signatures, keys, and lengths", () => {
    const valid = new Uint8Array([...message, ...signature]);
    const changedMessage = valid.slice();
    changedMessage[0] = (changedMessage[0] ?? 0) ^ 1;
    expect(() => extractVerifiedMessageSignature(message, changedMessage, publicKey)).toThrow(
      "changed the validation message",
    );
    const changedSignature = valid.slice();
    changedSignature[changedSignature.length - 1] =
      (changedSignature[changedSignature.length - 1] ?? 0) ^ 1;
    expect(() => extractVerifiedMessageSignature(message, changedSignature, publicKey)).toThrow(
      "invalid validation signature",
    );
    expect(() =>
      extractVerifiedMessageSignature(
        message,
        valid,
        ed25519.getPublicKey(new Uint8Array(32).fill(8)),
      ),
    ).toThrow("invalid validation signature");
    expect(() => extractVerifiedMessageSignature(message, valid.slice(1), publicKey)).toThrow(
      "malformed signed message payload",
    );
  });
});
