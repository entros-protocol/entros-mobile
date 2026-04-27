import { LissajousParams } from "@/components/pulse/LissajousCanvas";

const PHRASES = [
  "the quiet river bends past the lantern bridge",
  "seven tall pines hold the morning still",
  "a copper coin spins on the wooden table",
  "the lighthouse keeper watched the gulls return",
  "open windows let the warm wind speak",
  "the slow train passes the empty platform",
];

const PARAMS_POOL: LissajousParams[] = [
  { a: 3, b: 2, delta: Math.PI / 2 },
  { a: 5, b: 4, delta: Math.PI / 3 },
  { a: 4, b: 3, delta: Math.PI / 5 },
  { a: 5, b: 3, delta: Math.PI / 4 },
  { a: 3, b: 4, delta: Math.PI / 6 },
];

export const pickPhrase = (): string => PHRASES[Math.floor(Math.random() * PHRASES.length)]!;

export const pickLissajous = (): LissajousParams =>
  PARAMS_POOL[Math.floor(Math.random() * PARAMS_POOL.length)]!;
