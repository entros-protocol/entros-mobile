import { PublicKey } from "@solana/web3.js";
import { bytesToHex } from "@noble/hashes/utils";

import fixture from "./fixtures/request-bound.json";
import {
  canonicalScalar,
  encodeNativeProofAction,
  expectedNativePublicSignals,
  type NativeProofAction,
  type NativeProofManifest,
  prepareNativeProofRequest,
  SCALAR_MODULUS,
  validatePreparedNativeProofRequest,
} from "../request";

const address = (hex: string): string => new PublicKey(Buffer.from(hex, "hex")).toBase58();
const manifest: NativeProofManifest = {
  generation: "request-bound-v1",
  deploymentDomain: fixture.fields.deployment,
  verifierProgram: address(fixture.fields.verifier),
  consumerProgram: address(fixture.fields.consumer),
  genesisHash: address("22".repeat(32)),
  zkey: { uri: "file:///synthetic/key.zkey", sha256: "ab".repeat(32) },
};
const action: NativeProofAction = {
  identity: address(fixture.fields.identity),
  mint: address(fixture.fields.mint),
  counter: BigInt(fixture.counter),
  projectionVersion: fixture.projection,
  commitmentNew: fixture.commitmentNew,
  commitmentPrevious: fixture.commitmentPrevious,
  threshold: fixture.threshold,
  minDistance: fixture.minDistance,
  validUntil: BigInt(fixture.validUntil),
};
const prepare = (
  nextAction = action,
  nextManifest = manifest,
  nonce = fixture.fields.nonce,
  wallet = address(fixture.fields.wallet),
) => prepareNativeProofRequest(nextManifest, wallet, nonce, nextAction);

describe("native request encoding", () => {
  it("matches the independent fixed byte vector", () => {
    expect(bytesToHex(encodeNativeProofAction(action))).toBe(fixture.actionHex);
    const request = prepare();
    expect(request.digest).toBe(fixture.requestDigest);
    expect(request.digestHi).toBe(fixture.digestHi);
    expect(request.digestLo).toBe(fixture.digestLo);
    expect(expectedNativePublicSignals(request)).toEqual([
      "1",
      "2",
      "30",
      "3",
      fixture.digestHi,
      fixture.digestLo,
    ]);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.action)).toBe(true);
    expect(Object.isFrozen(request.manifest.zkey)).toBe(true);
  });

  it("binds every identity transition and action parameter", () => {
    const changes: NativeProofAction[] = [
      { ...action, identity: address("44".repeat(32)) },
      { ...action, mint: address("44".repeat(32)) },
      { ...action, counter: action.counter + 1n },
      { ...action, projectionVersion: action.projectionVersion + 1 },
      { ...action, commitmentNew: "0".repeat(63) + "4" },
      { ...action, commitmentPrevious: "0".repeat(63) + "4" },
      { ...action, threshold: action.threshold + 1 },
      { ...action, minDistance: action.minDistance + 1 },
      { ...action, validUntil: action.validUntil + 1n },
    ];
    for (const changed of changes) expect(prepare(changed).digest).not.toBe(fixture.requestDigest);
    expect(prepare(action, manifest, "44".repeat(32)).digest).not.toBe(fixture.requestDigest);
    expect(
      prepare(action, manifest, fixture.fields.nonce, address("44".repeat(32))).digest,
    ).not.toBe(fixture.requestDigest);
    for (const changed of [
      { ...manifest, deploymentDomain: "44".repeat(32) },
      { ...manifest, verifierProgram: address("44".repeat(32)) },
      { ...manifest, consumerProgram: address("44".repeat(32)) },
    ])
      expect(prepare(action, changed).digest).not.toBe(fixture.requestDigest);
  });

  it("rejects mutated prepared context", () => {
    const request = prepare();
    expect(() =>
      validatePreparedNativeProofRequest({
        ...request,
        action: { ...request.action, counter: 99n },
      }),
    ).toThrow("changed");
  });

  it.each([
    "-1",
    "+1",
    "01",
    "0x1",
    "1.5",
    SCALAR_MODULUS.toString(),
    (SCALAR_MODULUS + 1n).toString(),
  ])("rejects noncanonical scalar %s", (value) => {
    expect(() => canonicalScalar(value)).toThrow();
  });

  it("rejects invalid integer widths, absent nonces, and noncanonical bytes", () => {
    for (const changed of [
      { ...action, counter: -1n },
      { ...action, counter: 1n << 64n },
      { ...action, projectionVersion: 65536 },
      { ...action, threshold: 257 },
      { ...action, minDistance: 31 },
      { ...action, validUntil: 0n },
      { ...action, commitmentNew: SCALAR_MODULUS.toString(16).padStart(64, "0") },
    ])
      expect(() => prepare(changed)).toThrow();
    expect(() => prepare(action, manifest, "00".repeat(32))).toThrow();
    expect(() => prepare(action, manifest, "AB".repeat(32))).toThrow();
  });
});
