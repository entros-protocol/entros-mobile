import {
  COARSE_PATH_POINTS,
  CoarsePathError,
  scorePath,
  toCoarsePath,
  toGridPoint,
  type TraceSample,
} from "../coarsePath";
import { encodeCoarsePath, MAX_PATH_POINTS, MIN_PATH_POINTS } from "../transcript";

import { points, vectors } from "./vectors";

const surface = { width: 400, height: 200 };

function reason(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CoarsePathError) return error.reason;
    throw error;
  }
  throw new Error("Expected a coarse path rejection.");
}

describe("coarse path vectors", () => {
  test.each(vectors.coarsePaths.map((vector) => [vector.name, vector] as const))(
    "%s",
    (_name, vector) => {
      const trace = vector.trace.map(([x, y, t]) => ({ x, y, t }));
      const [width, height] = vector.surface;
      const outline = toCoarsePath(trace, { width, height });
      expect(outline).toHaveLength(COARSE_PATH_POINTS);
      expect(outline).toEqual(points(vector.outline));
    },
  );
});

describe("path scoring vectors", () => {
  test.each(vectors.pathScoring.map((vector) => [vector.name, vector] as const))(
    "%s",
    (_name, vector) => {
      expect(scorePath(points(vector.waypoints), points(vector.outline))).toEqual({
        reached: vector.reached,
        inOrder: vector.inOrder,
      });
    },
  );
});

describe("coarse path", () => {
  const diagonal: TraceSample[] = [
    { x: 0, y: 0, t: 0 },
    { x: 400, y: 200, t: 1_000 },
  ];

  test("returns exactly the requested count at each bound and by default", () => {
    expect(toCoarsePath(diagonal, surface, MIN_PATH_POINTS)).toHaveLength(MIN_PATH_POINTS);
    expect(toCoarsePath(diagonal, surface, MAX_PATH_POINTS)).toHaveLength(MAX_PATH_POINTS);
    expect(toCoarsePath(diagonal, surface)).toHaveLength(COARSE_PATH_POINTS);
  });

  test("refuses a count outside the wire bounds", () => {
    expect(() => toCoarsePath(diagonal, surface, MIN_PATH_POINTS - 1)).toThrow(RangeError);
    expect(() => toCoarsePath(diagonal, surface, MAX_PATH_POINTS + 1)).toThrow(RangeError);
    expect(() => toCoarsePath(diagonal, surface, 8.5)).toThrow(RangeError);
  });

  test("spaces points evenly along the trace and interpolates between samples", () => {
    const outline = toCoarsePath(
      [
        { x: 0, y: 0, t: 0 },
        { x: 400, y: 0, t: 700 },
        { x: 400, y: 200, t: 1_400 },
      ],
      surface,
      MIN_PATH_POINTS,
    );
    // On the grid the trace runs 1,000 across and 1,000 down, so eight points land every
    // 2,000 / 7 units and the corner falls between the fourth and the fifth.
    expect(outline).toEqual([
      { x: 0, y: 0 },
      { x: 286, y: 0 },
      { x: 571, y: 0 },
      { x: 857, y: 0 },
      { x: 1000, y: 143 },
      { x: 1000, y: 429 },
      { x: 1000, y: 714 },
      { x: 1000, y: 1000 },
    ]);
  });

  test("weights by length, not by time", () => {
    const outline = toCoarsePath(
      [
        { x: 0, y: 100, t: 0 },
        { x: 40, y: 100, t: 900 },
        { x: 400, y: 100, t: 1_000 },
      ],
      surface,
      11,
    );
    // Nine tenths of the time covers a tenth of the width and gets a tenth of the points.
    expect(outline.map((point) => point.x)).toEqual([
      0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
    ]);
  });

  test("orders samples by time and keeps samples that share a time in arrival order", () => {
    const inOrder = toCoarsePath(
      [
        { x: 0, y: 0, t: 0 },
        { x: 100, y: 0, t: 500 },
        { x: 300, y: 0, t: 500 },
        { x: 400, y: 0, t: 1_000 },
      ],
      surface,
      MIN_PATH_POINTS,
    );
    const shuffled = toCoarsePath(
      [
        { x: 400, y: 0, t: 1_000 },
        { x: 0, y: 0, t: 0 },
        { x: 100, y: 0, t: 500 },
        { x: 300, y: 0, t: 500 },
      ],
      surface,
      MIN_PATH_POINTS,
    );
    expect(shuffled).toEqual(inOrder);
    expect(inOrder.every((point, index) => index === 0 || point.x >= inOrder[index - 1]!.x)).toBe(
      true,
    );
  });

  test("quantises to the grid and clamps positions outside the surface", () => {
    const outline = toCoarsePath(
      [
        { x: -50, y: 300, t: 0 },
        { x: 450, y: -10, t: 10 },
      ],
      surface,
      MIN_PATH_POINTS,
    );
    expect(outline[0]).toEqual({ x: 0, y: 1000 });
    expect(outline[MIN_PATH_POINTS - 1]).toEqual({ x: 1000, y: 0 });
    for (const point of outline) {
      expect(Number.isInteger(point.x) && Number.isInteger(point.y)).toBe(true);
    }
    expect(() => encodeCoarsePath("trace", outline)).not.toThrow();
  });

  test("throws a typed error for fewer than two samples or a trace with no length", () => {
    expect(reason(() => toCoarsePath([], surface))).toBe("too_few_samples");
    expect(reason(() => toCoarsePath([{ x: 1, y: 1, t: 0 }], surface))).toBe("too_few_samples");
    // Two samples at one spot have no length, however far apart in time.
    expect(
      reason(() =>
        toCoarsePath(
          [
            { x: 2, y: 2, t: 5 },
            { x: 2, y: 2, t: 900 },
          ],
          surface,
        ),
      ),
    ).toBe("zero_length");
  });

  test("accepts samples that share a time when they have length", () => {
    expect(
      toCoarsePath(
        [
          { x: 1, y: 1, t: 5 },
          { x: 2, y: 2, t: 5 },
        ],
        surface,
      ),
    ).toHaveLength(COARSE_PATH_POINTS);
  });

  test("throws a typed error for a non-finite sample", () => {
    for (const bad of [
      { x: Number.NaN, y: 1, t: 0 },
      { x: 1, y: Number.POSITIVE_INFINITY, t: 0 },
      { x: 1, y: 1, t: Number.NaN },
    ]) {
      expect(reason(() => toCoarsePath([bad, { x: 2, y: 2, t: 4 }], surface))).toBe(
        "invalid_sample",
      );
    }
  });

  test("refuses a surface without area", () => {
    expect(() => toCoarsePath(diagonal, { width: 0, height: 200 })).toThrow(RangeError);
    expect(() => toGridPoint(1, 1, { width: 400, height: Number.NaN })).toThrow(RangeError);
  });

  test("maps a single position onto the same grid", () => {
    expect(toGridPoint(200, 50, surface)).toEqual({ x: 500, y: 250 });
    expect(toGridPoint(401, -1, surface)).toEqual({ x: 1000, y: 0 });
  });
});

describe("path scoring", () => {
  const waypoints = [
    { x: 100, y: 100 },
    { x: 500, y: 500 },
    { x: 900, y: 100 },
  ];

  test("scores the outline built from a trace through every waypoint in order", () => {
    const trace = waypoints.map((point, index) => ({ x: point.x, y: point.y, t: index }));
    const outline = toCoarsePath(trace, { width: 1000, height: 1000 });
    expect(scorePath(waypoints, outline)).toEqual({ reached: 3, inOrder: true });
  });

  test("never passes without waypoints or without an outline", () => {
    expect(scorePath([], [{ x: 0, y: 0 }])).toEqual({ reached: 0, inOrder: false });
    expect(scorePath(waypoints, [])).toEqual({ reached: 0, inOrder: false });
  });
});
