import { sha256 } from "@noble/hashes/sha2.js";

import { generateProjectionWords, PROJECTION_PURPOSE } from "../hyperplanes";
import { simhash, simhashDotProducts } from "../simhash";

const PUBLIC_SEED = Uint8Array.from([
  0x9e, 0xe9, 0xc0, 0x2f, 0x3f, 0xc6, 0xa2, 0xab, 0xce, 0x70, 0x30, 0x10, 0xe6, 0x43, 0x78, 0xd4,
  0x53, 0x1f, 0x8b, 0xcb, 0x11, 0x0f, 0x0b, 0xc4, 0xc1, 0x77, 0xc3, 0x6a, 0x60, 0xc7, 0x5b, 0xb5,
]);

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function legacyStringSeed(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }
  return hash;
}

describe("projection hyperplanes", () => {
  test("matches the frozen version 1 transcript", () => {
    expect(
      Array.from(generateProjectionWords(PUBLIC_SEED, PROJECTION_PURPOSE.public, 1, 308, 16)),
    ).toEqual([
      3999861642, 2593092573, 4116727045, 2423131132, 2704667368, 2600095892, 2308587662,
      1382458421, 177779353, 907165406, 8229536, 1299303692, 2312639962, 2709577244, 1868880545,
      2773743676,
    ]);
  });

  test("separates seed strings that collided under the legacy reducer", () => {
    expect(legacyStringSeed("Aa")).toBe(legacyStringSeed("BB"));

    const aaWords = generateProjectionWords(
      sha256(ascii("Aa")),
      PROJECTION_PURPOSE.public,
      1,
      308,
      8,
    );
    const bbWords = generateProjectionWords(
      sha256(ascii("BB")),
      PROJECTION_PURPOSE.public,
      1,
      308,
      8,
    );

    expect(Array.from(aaWords)).toEqual([
      1765681298, 1736910451, 3429764502, 1784947396, 3474463449, 1478806281, 3051658660,
      4255417318,
    ]);
    expect(Array.from(bbWords)).toEqual([
      2979806220, 1703678140, 3689915119, 1996824126, 3453479279, 2376161568, 593243097, 308904270,
    ]);
    expect(aaWords).not.toEqual(bbWords);
  });

  test.each([0, 307, 309])(
    "rejects a %i-value feature vector under projection version 1",
    (dimension) => {
      expect(() => simhash(new Array(dimension).fill(0), 1)).toThrow(
        "Projection version 1 requires exactly 308 features",
      );
    },
  );

  test("accepts exactly 308 features under projection version 1", () => {
    expect(simhash(new Array(308).fill(0), 1)).toHaveLength(256);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite feature value %s",
    (invalid) => {
      const features = new Array(308).fill(0);
      features[17] = invalid;

      expect(() => simhash(features, 1)).toThrow(
        "Feature vector contains a non-finite value at 17",
      );
      expect(() => simhashDotProducts(features, 1)).toThrow(
        "Feature vector contains a non-finite value at 17",
      );
    },
  );

  test("bounds the exported projection word stream", () => {
    expect(() => generateProjectionWords(PUBLIC_SEED, 255 as never, 1, 308, 1)).toThrow(
      "Projection purpose must be public or private",
    );
    expect(() =>
      generateProjectionWords(PUBLIC_SEED, PROJECTION_PURPOSE.public, 1, 309, 1),
    ).toThrow("Projection dimension must not exceed 308");
    expect(() =>
      generateProjectionWords(PUBLIC_SEED, PROJECTION_PURPOSE.public, 1, 308, 308 * 256 + 1),
    ).toThrow("Projection word count must not exceed");
  });
});
