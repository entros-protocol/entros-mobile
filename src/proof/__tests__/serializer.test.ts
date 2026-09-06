import fixture from "./fixtures/serialized-bound-proof.json";
import { BN254_BASE_FIELD } from "../constants";
import { serializeProof, toBigEndian32 } from "../serializer";
import type { RawProof } from "../types";

const proof = (): RawProof => JSON.parse(JSON.stringify(fixture.proof)) as RawProof;
const signals = fixture.publicSignals;

describe("canonical proof serialization", () => {
  it("preserves the generated proof bytes in both public-input formats", () => {
    expect(Array.from(serializeProof(proof(), signals, "request-bound-v1").proofBytes)).toEqual(
      fixture.proofBytes,
    );
    expect(Array.from(serializeProof(proof(), signals.slice(0, 4)).proofBytes)).toEqual(
      fixture.proofBytes,
    );
  });

  it.each(["-1", "+1", "01", " 1", "1 ", "0x01", "1.0", (1n << 256n).toString()])(
    "rejects invalid unsigned encoding %s",
    (value) => {
      expect(() => toBigEndian32(value)).toThrow();
    },
  );

  it("preserves the full unsigned byte range", () => {
    expect(Array.from(toBigEndian32("0"))).toEqual(new Array(32).fill(0));
    expect(Array.from(toBigEndian32(((1n << 256n) - 1n).toString()))).toEqual(
      new Array(32).fill(255),
    );
  });

  const coordinates = [
    [
      "a.x",
      (value: RawProof, coordinate: string) => {
        value.pi_a[0] = coordinate;
      },
    ],
    [
      "a.y",
      (value: RawProof, coordinate: string) => {
        value.pi_a[1] = coordinate;
      },
    ],
    [
      "b.x.c0",
      (value: RawProof, coordinate: string) => {
        value.pi_b[0]![0] = coordinate;
      },
    ],
    [
      "b.x.c1",
      (value: RawProof, coordinate: string) => {
        value.pi_b[0]![1] = coordinate;
      },
    ],
    [
      "b.y.c0",
      (value: RawProof, coordinate: string) => {
        value.pi_b[1]![0] = coordinate;
      },
    ],
    [
      "b.y.c1",
      (value: RawProof, coordinate: string) => {
        value.pi_b[1]![1] = coordinate;
      },
    ],
    [
      "c.x",
      (value: RawProof, coordinate: string) => {
        value.pi_c[0] = coordinate;
      },
    ],
    [
      "c.y",
      (value: RawProof, coordinate: string) => {
        value.pi_c[1] = coordinate;
      },
    ],
  ] as const;

  for (const [name, mutate] of coordinates) {
    it.each([
      "-1",
      "01",
      "+1",
      BN254_BASE_FIELD.toString(),
      (BN254_BASE_FIELD + 1n).toString(),
      (1n << 256n).toString(),
    ])(`rejects noncanonical ${name} %s`, (coordinate) => {
      const input = proof();
      mutate(input, coordinate);
      expect(() => serializeProof(input, signals, "request-bound-v1")).toThrow();
    });
  }

  it("rejects a projective proof before dropping its z coordinate", () => {
    const input = proof();
    input.pi_a[2] = "2";
    expect(() => serializeProof(input, signals, "request-bound-v1")).toThrow();
  });

  it("preserves the two-coordinate affine representation", () => {
    const input = proof();
    input.pi_a = input.pi_a.slice(0, 2);
    input.pi_b = input.pi_b.slice(0, 2);
    input.pi_c = input.pi_c.slice(0, 2);
    expect(Array.from(serializeProof(input, signals, "request-bound-v1").proofBytes)).toEqual(
      fixture.proofBytes,
    );
  });

  it("rejects incompatible metadata and coordinate shapes", () => {
    const mutations: ((input: RawProof) => void)[] = [
      (input) => {
        input.protocol = "plonk";
      },
      (input) => {
        input.curve = "bls12381";
      },
      (input) => {
        input.pi_a.push("1");
      },
      (input) => {
        input.pi_c[2] = "0";
      },
      (input) => {
        input.pi_b[2] = ["0", "0"];
      },
      (input) => {
        input.pi_b[2] = ["1", "1"];
      },
      (input) => {
        input.pi_b[0] = ["1"];
      },
      (input) => {
        input.pi_b[1]?.push("1");
      },
    ];
    for (const mutate of mutations) {
      const input = proof();
      mutate(input);
      expect(() => serializeProof(input, signals, "request-bound-v1")).toThrow();
    }
  });

  it("preserves zero coordinates for infinity encoding", () => {
    const input = proof();
    for (const [, mutate] of coordinates) mutate(input, "0");
    expect(Array.from(serializeProof(input, signals, "request-bound-v1").proofBytes)).toEqual(
      new Array(256).fill(0),
    );
  });
});
