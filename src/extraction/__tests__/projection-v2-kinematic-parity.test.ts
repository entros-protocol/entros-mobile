import { sha256 } from "@noble/hashes/sha2.js";

import { simhash } from "@/hashing";

import { extractMouseDynamics, extractTouchFeatures } from "../kinematic";
import { fuseFeatures } from "../statistics";
import type { TouchSample } from "../types";

const EXPECTED = {
  smooth: {
    30: {
      touch: "890d3fdb1844fa72aeb574efc7dc9813150669c9586bfba8ca3aafff7dbd1fab",
      mouse: "f7bb6c918e9797982975d6672764068973596275a537f237fba735d0988180be",
      fingerprint: "4b25c20b4ee62e5860d70be2a5cbde78885e6201698ba1a3f41eb977f945df56",
    },
    60: {
      touch: "540d1deeb3a89121c91c48431193e80a0e7a6a70544231967e457cbf69c3345f",
      mouse: "87e21bb2ad50a01e17276c0f9084e0c817b49438022b51e2f868d5452d5f8043",
      fingerprint: "4b25c20b2ee42e5b60d70be2a5dfde78885e6209e98ba1a3f41eb977f9c5df56",
    },
    120: {
      touch: "5fdcccf382cef7eee2a6e8089ba7e3d3d0a456a43b4db61b3ef579091f44137e",
      mouse: "f8738763b885d4e605664bc9081f83ac25b03551bd3faa2edb6bd18c43d5a9fc",
      fingerprint: "4ba5c20b2ee42e5b60d70be225dfde78805e6209e989a1a3f41eb977f9d5df56",
    },
  },
  paused: {
    30: {
      touch: "5b1fde976a10b0ba652497dfcdd3dc6f466a7d7fc67ac0a13cc2a0a070ee7945",
      mouse: "78d2e98ea56580441b72e52eba6345e201d9ca694ec3d7475e794c1d8440216c",
      fingerprint: "4385c30b2ee62e5be0d78be205cfde7c805e6a09e989a1a3f41e9977f9455b56",
    },
    60: {
      touch: "417ce404895ef64d6274ad5c3f64cac9c7d67005b250ffc8a241e836827368c1",
      mouse: "2b93d97f1a0aaecf6274b86a1ab52b3ae64296b0769d4287b92afb698e8fbef5",
      fingerprint: "4385c3092ee62e5be0d78be205cfde7c805e6a09e989a1a3f41e9977f9455b56",
    },
    120: {
      touch: "5a3a0783a5d603424f8a1978505f43c4a0854dd7b069f7f925de4d788bd10d92",
      mouse: "ca8d4a3d4a153f7d4556ed36032659297706972dc5954c26631c469f6ae9eab6",
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
  values.forEach((value, index) => view.setFloat64(index * 8, value, true));
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
