import { resampleCurveTrace } from "../curve";

describe("coarse curve trace", () => {
  test("creates a 64-point equal-time outline with no timestamps", () => {
    const raw = Array.from({ length: 241 }, (_, index) => ({
      t: index * 50,
      x: index / 2,
      y: 200 - index / 2,
    }));
    const outline = resampleCurveTrace(raw)!;
    expect(outline.points).toHaveLength(64);
    expect(outline.duration_ms).toBe(12_000);
    expect(outline.points[0]).toEqual([0, 200]);
    expect(outline.points.at(-1)).toEqual([120, 80]);
    expect(JSON.stringify(outline)).not.toContain('"t"');
  });

  test("rejects unusable input and removes malformed points", () => {
    expect(resampleCurveTrace([])).toBeUndefined();
    expect(resampleCurveTrace([{ t: 0, x: 1, y: 1 }])).toBeUndefined();
    expect(
      resampleCurveTrace([
        { t: 0, x: 0, y: 0 },
        { t: 1, x: Number.NaN, y: 1 },
        { t: 2, x: 2, y: 2 },
      ])!.points,
    ).toHaveLength(64);
  });
});
