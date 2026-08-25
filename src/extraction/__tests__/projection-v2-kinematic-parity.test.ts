import { sha256 } from "@noble/hashes/sha2.js";

import { simhash } from "@/hashing";

import { extractMouseDynamics, extractTouchFeatures } from "../kinematic";
import { fuseFeatures } from "../statistics";
import type { TouchSample } from "../types";

const EXPECTED = {
  smooth: {
    30: {
      touch: "f87b05d5a3154be8e947d52baf1088b43499ad949e080a7377f4fdd65f474bc9",
      mouse: "98998e891d88be63f376776593d785459cb860bcac30e692c826556c6f630ebf",
      fingerprint: "4b25c20b4ee62e5860d70be2a5cbde78885e6201698ba1a3f41eb977f945df56",
    },
    60: {
      touch: "f72ad954fd615f5d49e022f68cb320c2105eea9c94a9e457d6c5d4bbb5657c3b",
      mouse: "6ae2db25cff833b8cb6a954e25cddc9c87add8ae53897723e4c64b8281951316",
      fingerprint: "4b25c20b2ee42e5b60d70be2a5dfde78885e6209e98ba1a3f41eb977f9c5df56",
    },
    120: {
      touch: "4bed8390804da03da0a4fd7e148243d5f92373a624379ecf9050ba4301954263",
      mouse: "52c4162485d9b44103e671c13975c84a3042cb5f44783dd56e6d951432a15a54",
      fingerprint: "4ba5c20b2ee42e5b60d70be225dfde78805e6209e989a1a3f41eb977f9d5df56",
    },
  },
  paused: {
    30: {
      touch: "e30d32d588f69507db4c38f9ec01731ad3c198c7051c8228e4887d57075b5331",
      mouse: "018bd0161f059eec76ef6f87203ca48ab0e351f86b6c6af94250f864cd102018",
      fingerprint: "4385c30b2ee62e5be0d78be205cfde7c805e6a09e989a1a3f41e9977f9455b56",
    },
    60: {
      touch: "291e18a1c32d2bea2628668479ec57d28e8ca6f43004565a2b75f226f6663e0d",
      mouse: "ebbd002ee1c6c09ae92852d7fcfbe72f26738f01454903740a8c3bebd570fc4a",
      fingerprint: "4385c3092ee62e5be0d78be205cfde7c805e6a09e989a1a3f41e9977f9455b56",
    },
    120: {
      touch: "8d479b1784473f390d514e72c12b287fe3fdbdd31f9c3ea0db4e414140f9fa9e",
      mouse: "63e8e33fdca408ea6bb14603ff0afe899e84613c1a83ef6eb9af976aaa60d02d",
      fingerprint: "4385c3092ee62e5be0d78be205cfde7c805e6a09e989a1a3f41e9977f9455b56",
    },
  },
} as const;

type Profile = keyof typeof EXPECTED;
type Rate = keyof (typeof EXPECTED)[Profile];

function samples(profile: Profile, rate: Rate): TouchSample[] {
  return Array.from({ length: rate * 2 + 1 }, (_, index) => {
    const seconds = index / rate;
    const movingSeconds =
      profile === "paused" && seconds >= 0.6 ? (seconds < 1.2 ? 0.6 : seconds - 0.6) : seconds;
    return {
      timestamp: seconds * 1_000,
      x: profile === "smooth" ? 0.1 + 0.2 * seconds : 0.2 + 0.18 * movingSeconds,
      y:
        profile === "smooth"
          ? 0.5 + 0.12 * Math.sin(seconds * Math.PI * 1.5)
          : 0.35 + 0.08 * Math.sin(movingSeconds * Math.PI * 2),
      pressure: profile === "smooth" ? 0.45 + 0.04 * Math.cos(seconds * Math.PI) : 0.5,
      width: 1,
      height: 1,
    };
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function digestFloats(values: number[]): string {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  // Quantize fixture snapshots so platform math libraries cannot change their identity.
  values.forEach((value, index) => {
    const stableValue = Math.round(value * 1e12) / 1e12;
    view.setFloat64(index * 8, stableValue === 0 ? 0 : stableValue, true);
  });
  return bytesToHex(sha256(bytes));
}

function packFingerprint(bits: number[]): string {
  const bytes = new Uint8Array(32);
  bits.forEach((bit, index) => {
    if (bit === 1) bytes[index >> 3] = (bytes[index >> 3] ?? 0) | (1 << (index & 7));
  });
  return bytesToHex(bytes);
}

describe("projection 2 kinematic parity", () => {
  for (const profile of Object.keys(EXPECTED) as Profile[]) {
    for (const rate of [30, 60, 120] as const) {
      test(`${profile} ${rate} Hz matches the shared browser fixture`, () => {
        const fixture = samples(profile, rate);
        const touch = extractTouchFeatures(fixture, 2);
        const mouse = extractMouseDynamics(fixture, 2);
        const features = fuseFeatures(new Array(170).fill(0), new Array(81).fill(0), touch);
        const expected = EXPECTED[profile][rate];

        expect(digestFloats(touch)).toBe(expected.touch);
        expect(digestFloats(mouse)).toBe(expected.mouse);
        expect(packFingerprint(simhash(features, 2))).toBe(expected.fingerprint);
      });
    }
  }
});
