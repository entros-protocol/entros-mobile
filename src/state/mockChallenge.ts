// Lissajous shape parameters for the trace canvas. The shape is purely a
// UI helper — visually distinct curves so the touch trace looks intentional
// — and is NOT bound to the executor's challenge. The voice phrase comes
// from /challenge (see src/services/executor.ts) and lives in
// challengeBuffer; this module only owns the pickLissajous helper.

import { LissajousParams } from "@/components/pulse/LissajousCanvas";

const PARAMS_POOL: LissajousParams[] = [
  { a: 3, b: 2, delta: Math.PI / 2 },
  { a: 5, b: 4, delta: Math.PI / 3 },
  { a: 4, b: 3, delta: Math.PI / 5 },
  { a: 5, b: 3, delta: Math.PI / 4 },
  { a: 3, b: 4, delta: Math.PI / 6 },
];

export const pickLissajous = (): LissajousParams =>
  PARAMS_POOL[Math.floor(Math.random() * PARAMS_POOL.length)]!;
