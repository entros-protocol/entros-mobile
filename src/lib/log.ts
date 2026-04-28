// Diagnostic logging gated to dev builds. In release builds Metro inlines
// `process.env.NODE_ENV === "production"` to a literal `true`, and any code
// inside the guard is dead-code-eliminated by the minifier — so this is
// genuinely zero-overhead at runtime.
//
// Use this anywhere you'd reach for `console.warn` for diagnostics. Real
// errors that should always surface (vs diagnostic chatter) should still
// throw or use `console.error`.

const isProduction = process.env.NODE_ENV === "production";

export const devWarn = (...args: unknown[]): void => {
  if (isProduction) return;
  // eslint-disable-next-line no-console
  console.warn(...args);
};
