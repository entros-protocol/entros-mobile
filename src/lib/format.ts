// Display-formatting helpers shared across screens. Pure functions, no
// React. Test-friendly. Add new formatters here rather than redeclaring at
// the screen level.

// Truncate a long string (typically a base58 wallet address or commitment) to
// a fixed-width "head…tail" form. Defaults are tuned for compact UI rows;
// pass explicit head/tail for tighter or wider contexts.
export const truncate = (s: string, head = 6, tail = 4): string =>
  s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;

// Render an absolute timestamp as a relative phrase ("3m ago", "2h ago",
// "Never"). Stable enough for low-frequency UI; do not use for sub-minute
// precision since `Just now` covers everything under 60s.
export const relative = (date: Date | null): string => {
  if (!date) return "Never";
  const ms = Date.now() - date.getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
};
