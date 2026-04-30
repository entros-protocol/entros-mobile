// Live-tick countdown text for retry-bucket failure screens.
//
// Decrements once per second from `seconds` toward 0; fires `onExpire` when
// it reaches 0 so the parent can flip CTA copy ("OK" → "Try again") and
// re-enable navigation. The interval is cleared on unmount and on prop
// change so the component is safe in both the foreground-mounted screen
// case and the rapid back-nav case.
//
// Pure render output: text only — no icons, no layout. Caller wraps it in
// whatever Text variant matches the surrounding copy (mirrors the existing
// `formatRetryWindow` static text the failure screen used pre-Phase 5).

import { useEffect, useState } from "react";

import { Text } from "@/components/primitives/Text";

interface CountdownProps {
  /** Initial seconds. Floored to non-negative integer. */
  seconds: number;
  /** Fires once when the counter hits 0. */
  onExpire?: () => void;
}

/** Formats remaining seconds the same way the static `formatRetryWindow`
 *  did: "1 minute", "23 seconds", etc. Singular vs plural handled inline. */
const formatRemaining = (s: number): string => {
  if (s >= 60) {
    const mins = Math.ceil(s / 60);
    return `${mins} minute${mins === 1 ? "" : "s"}`;
  }
  return `${s} second${s === 1 ? "" : "s"}`;
};

export function Countdown({ seconds, onExpire }: CountdownProps): JSX.Element {
  const initial = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const [remaining, setRemaining] = useState(initial);

  useEffect(() => {
    setRemaining(initial);
    if (initial <= 0) {
      onExpire?.();
      return;
    }
    const id = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          onExpire?.();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
    // `onExpire` intentionally excluded from deps — capturing a stable handler
    // would require the caller to memoise it; firing on every parent re-render
    // would reset the timer mid-tick. The hook closes over the handler at
    // mount + each `initial` change, which is the right cadence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  return <Text variant="body">{formatRemaining(remaining)}</Text>;
}
