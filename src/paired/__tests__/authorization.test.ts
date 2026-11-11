import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { PublicKey } from "@solana/web3.js";

import {
  isPairedAuthorizationRefusal,
  PAIRED_AUTHORIZATION_MARGIN_MS,
  pairedAuthorizationBody,
  pairedAuthorizationMessage,
  pairedAuthorizationUsable,
  PairedClientError,
  parsePairedAuthorizationGrant,
  signedPairedAuthorization,
} from "@/paired";

// The vector the relayer and the web client pin. A change to the signed
// message on any side fails here.
const SEED = new Uint8Array(32).fill(0x07);
const WALLET = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const CHALLENGE = "22".repeat(32);
const EXPIRES_AT = 1_800_000_000;
const ORIGIN = "4bd598d57ec9d5aacaffc4f0ca573ece";
const MAC = "92dd5d5e281678bc041d28c30a9d49e2878f0e87b18710fec211dc70f61379fb";
const SIGNATURE =
  "a50c16c0bac5a61d9c017184d803de45e7451b782e25be1c2d684e6c6814cff0bea246c5d0e2a4484a4798034f376c1a2db2498b75428045ba1a7cc803bd7a08";
const MESSAGE =
  "Entros verification\n" +
  "Sign to start verification sessions for this wallet. The authorization expires within the hour. It moves no funds and approves no transaction.\n" +
  "\n" +
  "Entros-Paired-Open-v1\n" +
  `wallet:${WALLET}\n` +
  `challenge:${CHALLENGE}\n` +
  `expires:${EXPIRES_AT}`;

/** Both clocks advanced by the same amount from zero. */
const at = (ms: number) => ({ monotonicMs: ms, wallMs: ms });

const grantJson = (overrides: Record<string, unknown> = {}) => ({
  challenge: CHALLENGE,
  expires_at: EXPIRES_AT,
  expires_in: 900,
  origin: ORIGIN,
  mac: MAC,
  ...overrides,
});

describe("paired authorization", () => {
  test("signs the message the relayer verifies", () => {
    expect(new PublicKey(ed25519.getPublicKey(SEED)).toBase58()).toBe(WALLET);
    const message = pairedAuthorizationMessage(WALLET, CHALLENGE, EXPIRES_AT);
    expect(message).toBe(MESSAGE);
    expect(new TextEncoder().encode(message)).toHaveLength(331);
    // Ed25519 is deterministic, so the same key and message give the pinned signature.
    expect(bytesToHex(ed25519.sign(new TextEncoder().encode(message), SEED))).toBe(SIGNATURE);
  });

  test("sends the grant and the signature in the relayer's field names", () => {
    const grant = parsePairedAuthorizationGrant(grantJson());
    const requestedAt = { monotonicMs: 1_000, wallMs: 1_700_000_000_000 };
    const authorization = signedPairedAuthorization(
      WALLET,
      grant,
      hexToBytes(SIGNATURE),
      requestedAt,
    );
    expect(pairedAuthorizationBody(authorization)).toEqual({
      challenge: CHALLENGE,
      expires_at: EXPIRES_AT,
      origin: ORIGIN,
      mac: MAC,
      signature_hex: SIGNATURE,
    });
    // The lifetime counts from the readings taken before the request.
    expect(authorization.lifetimeMs).toBe(900_000);
    expect(authorization.requestedAt).toEqual(requestedAt);
  });

  test.each([
    ["a non-object", "grant"],
    ["an uppercase challenge", grantJson({ challenge: "AB".repeat(32) })],
    ["a short challenge", grantJson({ challenge: "22".repeat(31) })],
    ["a long origin tag", grantJson({ origin: "4b".repeat(17) })],
    ["a short MAC", grantJson({ mac: "92".repeat(31) })],
    ["a fractional expiry", grantJson({ expires_at: 1.5 })],
    ["a string expiry", grantJson({ expires_at: String(EXPIRES_AT) })],
    ["no lifetime", grantJson({ expires_in: 0 })],
    ["a lifetime past an hour", grantJson({ expires_in: 3_601 })],
    ["a lifetime inside the usable margin", grantJson({ expires_in: 120 })],
  ])("refuses a grant with %s", (_name, value) => {
    expect(() => parsePairedAuthorizationGrant(value)).toThrow(PairedClientError);
  });

  test("names the lifetime field when the lifetime leaves no usable time", () => {
    let refusal: unknown;
    try {
      parsePairedAuthorizationGrant(grantJson({ expires_in: 120 }));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PairedClientError);
    expect(refusal).toMatchObject({
      kind: "invalid_response",
      reason: "malformed_response",
      field: "authorization.expires_in",
    });
    expect(parsePairedAuthorizationGrant(grantJson({ expires_in: 121 })).expiresInSecs).toBe(121);
  });

  test("refuses a signature that is not 64 bytes and a wallet that is not base58", () => {
    const grant = parsePairedAuthorizationGrant(grantJson());
    expect(() => signedPairedAuthorization(WALLET, grant, new Uint8Array(63), at(0))).toThrow(
      RangeError,
    );
    expect(() => signedPairedAuthorization("0x1234", grant, new Uint8Array(64), at(0))).toThrow(
      RangeError,
    );
  });

  test("serves its wallet until the margin before expiry", () => {
    const grant = parsePairedAuthorizationGrant(grantJson());
    const authorization = signedPairedAuthorization(WALLET, grant, hexToBytes(SIGNATURE), at(0));
    const lastUsableMs = 900_000 - PAIRED_AUTHORIZATION_MARGIN_MS;
    expect(pairedAuthorizationUsable(authorization, WALLET, at(lastUsableMs))).toBe(true);
    expect(pairedAuthorizationUsable(authorization, WALLET, at(lastUsableMs + 1))).toBe(false);
    expect(
      pairedAuthorizationUsable(authorization, "11111111111111111111111111111111", at(0)),
    ).toBe(false);
    expect(pairedAuthorizationUsable(null, WALLET, at(0))).toBe(false);
  });

  test("counts time the monotonic clock missed while the device slept", () => {
    const grant = parsePairedAuthorizationGrant(grantJson());
    const authorization = signedPairedAuthorization(WALLET, grant, hexToBytes(SIGNATURE), {
      monotonicMs: 5_000,
      wallMs: 1_700_000_000_000,
    });
    // The monotonic clock stood still for 800 s of wall time.
    expect(
      pairedAuthorizationUsable(authorization, WALLET, {
        monotonicMs: 5_000,
        wallMs: 1_700_000_800_000,
      }),
    ).toBe(false);
  });

  test("ignores a wall clock that is off by a constant", () => {
    const grant = parsePairedAuthorizationGrant(grantJson());
    const skew = 9 * 3_600_000;
    const authorization = signedPairedAuthorization(WALLET, grant, hexToBytes(SIGNATURE), {
      monotonicMs: 0,
      wallMs: 1_700_000_000_000 + skew,
    });
    expect(
      pairedAuthorizationUsable(authorization, WALLET, {
        monotonicMs: 780_000,
        wallMs: 1_700_000_780_000 + skew,
      }),
    ).toBe(true);
  });

  test("does not extend the lifetime when the wall clock moves backwards", () => {
    const grant = parsePairedAuthorizationGrant(grantJson());
    const authorization = signedPairedAuthorization(WALLET, grant, hexToBytes(SIGNATURE), {
      monotonicMs: 0,
      wallMs: 1_700_000_000_000,
    });
    const rewound = 1_700_000_000_000 - 3_600_000;
    expect(
      pairedAuthorizationUsable(authorization, WALLET, { monotonicMs: 780_000, wallMs: rewound }),
    ).toBe(true);
    expect(
      pairedAuthorizationUsable(authorization, WALLET, { monotonicMs: 780_001, wallMs: rewound }),
    ).toBe(false);
  });

  test("names the two refusals that need a new signature", () => {
    expect(isPairedAuthorizationRefusal("authorization_required")).toBe(true);
    expect(isPairedAuthorizationRefusal("authorization_invalid")).toBe(true);
    expect(isPairedAuthorizationRefusal("session_active")).toBe(false);
    expect(isPairedAuthorizationRefusal(undefined)).toBe(false);
  });
});
