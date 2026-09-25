import { useEffect, useRef, useState } from "react";

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

interface CountdownRunProps {
  initial: number;
  onExpire?: () => void;
}

function CountdownRun({ initial, onExpire }: CountdownRunProps) {
  const [remaining, setRemaining] = useState(initial);
  const onExpireRef = useRef(onExpire);

  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  useEffect(() => {
    if (initial <= 0) {
      onExpireRef.current?.();
      return;
    }

    let next = initial;
    const id = setInterval(() => {
      next = Math.max(0, next - 1);
      setRemaining(next);
      if (next !== 0) return;
      clearInterval(id);
      onExpireRef.current?.();
    }, 1000);
    return () => clearInterval(id);
  }, [initial]);

  return <Text variant="body">{formatRemaining(remaining)}</Text>;
}

export function Countdown({ seconds, onExpire }: CountdownProps) {
  const initial = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return <CountdownRun key={initial} initial={initial} onExpire={onExpire} />;
}
