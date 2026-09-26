import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  attemptBindingDigest,
  attestationDigest,
  audioDigest,
  challengeDigest,
  checkTierPointCount,
  commitRequestDigest,
  COORDINATE_MAX,
  decodeCoarsePath,
  decodePathTarget,
  encode,
  encodeCoarsePath,
  encodePathTarget,
  evidenceManifest,
  finalDigest,
  MAX_PATH_POINTS,
  MAX_ROUND_SAMPLES,
  MAX_SESSION_SAMPLES,
  MAX_WAYPOINTS,
  MIN_PATH_POINTS,
  MIN_WAYPOINTS,
  PAIRED_AUDIO_FORMAT,
  PAIRED_PROTOCOL_VERSION,
  PAIRED_ROUND_DOMAINS,
  PAIRED_ROUNDS,
  PAIRED_SAMPLE_RATE,
  PairedEncodingError,
  PATH_SCHEMA_VERSION,
  pathDigest,
  roundCommitment,
  sessionCommitment,
  type PairedEncodingReason,
} from "../transcript";
import { TRIM_TAIL_SAMPLES } from "../segment";

import {
  bytes,
  EXPECTED_PAIRED_ROUND_VECTORS_SHA256,
  pairedRoundVectorBytes,
  points,
  vectors,
} from "./vectors";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function encodingReason(run: () => unknown): PairedEncodingReason {
  try {
    run();
  } catch (error) {
    if (error instanceof PairedEncodingError) return error.reason;
    throw error;
  }
  throw new Error("Expected an encoding rejection.");
}

describe("paired-round vector file", () => {
  test("pins the shared vector bytes", () => {
    expect(bytesToHex(sha256(pairedRoundVectorBytes))).toBe(EXPECTED_PAIRED_ROUND_VECTORS_SHA256);
    expect(vectors.schema).toBe("entros-paired-round-vectors-v1");
  });

  test("domains match the generator", () => {
    for (const [key, domain] of Object.entries(PAIRED_ROUND_DOMAINS)) {
      expect({ key, domain }).toEqual({ key, domain: vectors.domains[key] });
    }
  });

  test("constants match the generator", () => {
    // Server settings the client never reads. The server reports the session
    // and round lifetimes with each response. Any other constant the generator
    // adds fails here until the client pins it.
    const serverOnly = new Set(["sessionExpirySeconds", "roundExpirySeconds", "separatorSamples"]);
    const clientConstants = Object.fromEntries(
      Object.entries(vectors.constants).filter(([key]) => !serverOnly.has(key)),
    );
    expect({
      rounds: PAIRED_ROUNDS,
      protocolVersion: PAIRED_PROTOCOL_VERSION,
      schemaVersion: PATH_SCHEMA_VERSION,
      sampleRate: PAIRED_SAMPLE_RATE,
      audioFormat: PAIRED_AUDIO_FORMAT,
      maxRoundSamples: MAX_ROUND_SAMPLES,
      maxSessionSamples: MAX_SESSION_SAMPLES,
      trimTailSamples: TRIM_TAIL_SAMPLES,
      minPathPoints: MIN_PATH_POINTS,
      maxPathPoints: MAX_PATH_POINTS,
      minWaypoints: MIN_WAYPOINTS,
      maxWaypoints: MAX_WAYPOINTS,
      coordinateMax: COORDINATE_MAX,
    }).toEqual(clientConstants);
  });
});

describe.each(vectors.sessions.map((session) => [session.name, session] as const))(
  "session vector: %s",
  (_name, session) => {
    const sessionNonce = bytes(session.sessionNonceHex);

    test("reproduces the attempt binding and C_0", () => {
      const attempt = attemptBindingDigest(
        bytes(session.serverAttemptIdHex),
        bytes(session.originalChallengeNonceHex),
      );
      expect(bytesToHex(attempt)).toBe(session.attemptBindingDigestHex);
      expect(
        bytesToHex(
          sessionCommitment(sessionNonce, attempt, session.rounds, session.sessionExpiryUnixMs),
        ),
      ).toBe(session.sessionCommitmentHex);
    });

    test("reproduces every round digest, the manifest and the final digest", () => {
      let previous = bytes(session.sessionCommitmentHex);
      const entries = [];
      for (const round of session.roundEntries) {
        const target = encodePathTarget(session.tier, points(round.pathTargetWaypoints));
        expect(bytesToHex(target)).toBe(round.pathTargetHex);
        expect(decodePathTarget(session.tier, target)).toEqual(points(round.pathTargetWaypoints));

        const path = encodeCoarsePath(session.tier, points(round.coarsePathPoints));
        expect(bytesToHex(path)).toBe(round.coarsePathHex);
        expect(decodeCoarsePath(session.tier, path)).toEqual(points(round.coarsePathPoints));
        expect(() => checkTierPointCount(session.tier, round.pathPointCount)).not.toThrow();

        const challenge = challengeDigest(
          sessionNonce,
          round.index,
          bytes(round.roundNonceHex),
          round.word,
          target,
        );
        expect(bytesToHex(challenge)).toBe(round.challengeDigestHex);

        const segment = bytes(round.audioSegmentHex);
        expect(segment.length).toBe(round.audioByteLength);
        const audio = audioDigest(sessionNonce, round.index, challenge, round.audioFormat, segment);
        expect(bytesToHex(audio)).toBe(round.audioDigestHex);

        const pathHash = pathDigest(sessionNonce, round.index, challenge, path);
        expect(bytesToHex(pathHash)).toBe(round.pathDigestHex);

        expect(bytesToHex(previous)).toBe(round.previousCommitmentHex);
        const current = roundCommitment({
          sessionNonce,
          roundIndex: round.index,
          roundNonce: bytes(round.roundNonceHex),
          challengeDigest: challenge,
          previousCommitment: previous,
          audioFormat: round.audioFormat,
          audioByteLength: segment.length,
          audioDigest: audio,
          pathPointCount: round.pathPointCount,
          pathDigest: pathHash,
        });
        expect(bytesToHex(current)).toBe(round.commitmentHex);

        const request = commitRequestDigest({
          sessionNonce,
          roundIndex: round.index,
          roundNonce: bytes(round.roundNonceHex),
          challengeDigest: challenge,
          previousCommitment: previous,
          commitment: current,
          audioFormat: round.audioFormat,
          audioByteLength: segment.length,
          pathPointCount: round.pathPointCount,
        });
        expect(bytesToHex(request)).toBe(round.requestDigestHex);

        entries.push({ audioDigest: audio, pathDigest: pathHash });
        previous = current;
      }

      const manifest = evidenceManifest(entries);
      expect(bytesToHex(manifest)).toBe(session.evidenceManifestHex);
      expect(bytesToHex(finalDigest(sessionNonce, previous, session.rounds, manifest))).toBe(
        session.finalDigestHex,
      );
    });
  },
);

describe("invalid encodings", () => {
  test.each(vectors.invalidEncodings.map((vector) => [vector.name, vector] as const))(
    "rejects %s",
    (_name, vector) => {
      let reason: PairedEncodingReason;
      switch (vector.encoding) {
        case "pathTarget":
          reason = encodingReason(() => encodePathTarget("trace", points(vector.waypoints)));
          break;
        case "coarsePath":
          reason = encodingReason(() => encodeCoarsePath("trace", points(vector.points)));
          break;
        case "tier":
          reason = encodingReason(() => checkTierPointCount(vector.tier, vector.pointCount));
          break;
      }
      expect(reason).toBe(vector.reason);
    },
  );

  test("the decoders reject what the encoders reject", () => {
    const target = encodePathTarget("trace", [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 5, y: 6 },
    ]);
    const shortTarget = Uint8Array.from([PATH_SCHEMA_VERSION, 2, ...target.subarray(2, 10)]);
    expect(encodingReason(() => decodePathTarget("trace", shortTarget))).toBe(
      "waypoint_count_out_of_range",
    );
    const offGrid = target.slice();
    offGrid.set([0x03, 0xe9], 2);
    expect(encodingReason(() => decodePathTarget("trace", offGrid))).toBe(
      "coordinate_out_of_range",
    );
    expect(encodingReason(() => decodePathTarget("trace", target.subarray(0, 9)))).toBe(
      "malformed",
    );

    const path = encodeCoarsePath(
      "trace",
      Array.from({ length: MIN_PATH_POINTS }, () => ({ x: 10, y: 10 })),
    );
    const overCount = path.slice();
    overCount[2] = MIN_PATH_POINTS + 1;
    expect(encodingReason(() => decodeCoarsePath("trace", overCount))).toBe("malformed");
    const wrongVersion = path.slice();
    wrongVersion[0] = 2;
    expect(encodingReason(() => decodeCoarsePath("trace", wrongVersion))).toBe("malformed");
    expect(encodingReason(() => decodeCoarsePath("speech_only", path))).toBe("tier_violation");
    expect(encodingReason(() => encodeCoarsePath("trace", [{ x: 1.5, y: 2 }]))).toBe(
      "point_count_out_of_range",
    );
    expect(
      encodingReason(() =>
        encodeCoarsePath(
          "trace",
          Array.from({ length: MIN_PATH_POINTS }, () => ({ x: 1.5, y: 2 })),
        ),
      ),
    ).toBe("coordinate_out_of_range");
  });
});

describe("length-prefix separation", () => {
  test("separates two field splits that naive concatenation merges", () => {
    const { separation } = vectors;
    const left = encode(separation.leftFields.map(text));
    const right = encode(separation.rightFields.map(text));
    expect(bytesToHex(left)).toBe(separation.encodedLeftHex);
    expect(bytesToHex(right)).toBe(separation.encodedRightHex);
    expect(separation.naiveConcatenationMatches).toBe(true);
    expect(separation.leftFields.join("")).toBe(separation.rightFields.join(""));
    expect(bytesToHex(sha256(left)) !== bytesToHex(sha256(right))).toBe(
      separation.encodedDigestsDiffer,
    );
  });
});

describe("commitment recompute", () => {
  const accepted = vectors.commitRecompute.find((vector) => vector.name === "accepted fields");

  test.each(vectors.commitRecompute.map((vector) => [vector.name, vector] as const))(
    "%s",
    (_name, vector) => {
      const commitment = roundCommitment({
        sessionNonce: bytes(vector.sessionNonceHex),
        roundIndex: vector.roundIndex,
        roundNonce: bytes(vector.roundNonceHex),
        challengeDigest: bytes(vector.challengeDigestHex),
        previousCommitment: bytes(vector.previousCommitmentHex),
        audioFormat: vector.audioFormat,
        audioByteLength: vector.audioByteLength,
        audioDigest: bytes(vector.audioDigestHex),
        pathPointCount: vector.pathPointCount,
        pathDigest: bytes(vector.pathDigestHex),
      });
      expect(bytesToHex(commitment)).toBe(vector.expectedCommitmentHex);
      expect(bytesToHex(commitment) === accepted?.expectedCommitmentHex).toBe(
        vector.matchesAcceptedCommitment,
      );
    },
  );
});

describe("attestation digest", () => {
  test.each(vectors.attestation.map((vector) => [vector.name, vector] as const))(
    "%s",
    (_name, vector) => {
      const digest = attestationDigest({
        protocolVersion: vector.protocolVersion,
        sessionNonce: bytes(vector.sessionNonceHex),
        attemptBinding: bytes(vector.attemptBindingDigestHex),
        finalDigest: bytes(vector.finalDigestHex),
        projectionVersion: vector.projectionVersion,
      });
      expect(bytesToHex(digest)).toBe(vector.digestHex);
      expect(bytesToHex(digest)).toBe(vector.requestHash);
    },
  );
});
