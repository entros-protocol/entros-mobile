export interface LissajousParams {
  a: number;
  b: number;
  delta: number;
  points: number;
  anchorX: number;
  anchorY: number;
}

export interface Point2D {
  x: number;
  y: number;
}

const ISSUED_RATIOS = new Set(["1:2", "2:3", "3:4", "3:5", "4:5"]);
const ISSUED_ANCHORS = new Set(["0:0", "100:0", "0:100", "100:100", "50:50"]);

export function generateLissajousPoints(params: LissajousParams): Point2D[] {
  const result = new Array<Point2D>(params.points);
  for (let index = 0; index < params.points; index++) {
    const t = (index / params.points) * Math.PI * 2;
    result[index] = {
      x: ((Math.sin(params.a * t + params.delta) + 1) / 2) * 100 + params.anchorX,
      y: ((Math.sin(params.b * t) + 1) / 2) * 100 + params.anchorY,
    };
  }
  return result;
}

export function validateLissajousParams(value: unknown): LissajousParams {
  if (!value || typeof value !== "object") {
    throw new Error("Executor returned a malformed touch curve.");
  }
  const body = value as Record<string, unknown>;
  const a = body.a;
  const b = body.b;
  const delta = body.delta;
  const points = body.points;
  const anchorX = body.anchor_x;
  const anchorY = body.anchor_y;
  if (
    !Number.isInteger(a) ||
    typeof a !== "number" ||
    !Number.isInteger(b) ||
    typeof b !== "number" ||
    !ISSUED_RATIOS.has(`${a}:${b}`) ||
    typeof delta !== "number" ||
    !Number.isFinite(delta) ||
    delta < Math.PI * 0.25 ||
    delta > Math.PI * 0.75 ||
    !Number.isInteger(points) ||
    typeof points !== "number" ||
    points !== 200 ||
    !Number.isInteger(anchorX) ||
    typeof anchorX !== "number" ||
    !Number.isInteger(anchorY) ||
    typeof anchorY !== "number" ||
    !ISSUED_ANCHORS.has(`${anchorX}:${anchorY}`)
  ) {
    throw new Error("Executor returned a malformed touch curve.");
  }
  return { a, b, delta, points, anchorX, anchorY };
}
