import { MutableRefObject, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

import { Text } from "../primitives/Text";

const TICK_MS = 110;

export interface SensorLevels {
  /** Voice RMS in [0, 1]. */
  voice: number;
  /** Motion magnitude normalised to [0, 1]. */
  motion: number;
  /** Touch velocity normalised to [0, 1]. */
  touch: number;
}

interface ColumnProps {
  label: string;
  count: number;
  color: string;
  active: boolean;
  /** Mutable ref read on each tick — bypasses React entirely so the parent
   *  can update levels at sensor cadence (60Hz+) without re-rendering. */
  levelRef?: MutableRefObject<number>;
}

const randomWalk = (current: number, energy: number): number => {
  const drift = (Math.random() - 0.5) * 0.8;
  const target = energy + drift;
  return Math.max(0.06, Math.min(1, current * 0.55 + target * 0.45));
};

const BarColumn = ({ label, count, color, active, levelRef }: ColumnProps) => {
  const { palette } = useTheme();
  const isLive = !!levelRef;
  const [bars, setBars] = useState<number[]>(() => Array.from({ length: count }, () => 0.15));

  useEffect(() => {
    if (!active) {
      setBars((prev) => prev.map((v) => v * 0.6));
      return;
    }
    const id = setInterval(() => {
      setBars((prev) => {
        if (isLive) {
          const t = Math.max(0, Math.min(1, levelRef.current));
          return prev.map((v) => {
            const jitter = (Math.random() - 0.5) * 0.25;
            const target = Math.max(0.05, Math.min(1, t + jitter));
            return v * 0.45 + target * 0.55;
          });
        }
        return prev.map((v) => randomWalk(v, 0.45));
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [active, isLive, levelRef]);

  return (
    <View style={styles.column}>
      <View style={styles.bars}>
        {bars.map((value, i) => (
          <View
            key={i}
            style={[
              styles.bar,
              {
                height: 6 + value * 36,
                backgroundColor: active ? color : palette.textSubtle,
                opacity: active ? 0.4 + value * 0.6 : 0.45,
              },
            ]}
          />
        ))}
      </View>
      <Text variant="label" tone="muted" align="center">
        {label}
      </Text>
    </View>
  );
};

interface SensorBarsProps {
  active?: boolean;
  /** Live mode: pass mutable refs that the sensor layer writes to at native
   *  cadence. Each column samples its ref every TICK_MS without React state
   *  changes upstream. Omit to run a random-walk preview. */
  levels?: {
    voice: MutableRefObject<number>;
    motion: MutableRefObject<number>;
    touch: MutableRefObject<number>;
  };
}

export const SensorBars = ({ active = true, levels }: SensorBarsProps) => {
  const { palette } = useTheme();
  const config = useMemo(
    () => [
      {
        key: "voice" as const,
        label: "VOICE",
        count: 12,
        color: palette.accent,
        ref: levels?.voice,
      },
      {
        key: "motion" as const,
        label: "MOTION",
        count: 6,
        color: palette.solanaPurple,
        ref: levels?.motion,
      },
      {
        key: "touch" as const,
        label: "TOUCH",
        count: 10,
        color: palette.solanaGreen,
        ref: levels?.touch,
      },
    ],
    [palette, levels],
  );

  return (
    <View style={styles.row}>
      {config.map((c) => (
        <BarColumn
          key={c.key}
          label={c.label}
          count={c.count}
          color={c.color}
          active={active}
          levelRef={c.ref}
        />
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "flex-end",
    gap: spacing.lg,
    width: "100%",
  },
  column: {
    flex: 1,
    gap: spacing.sm,
    alignItems: "center",
  },
  bars: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 3,
    height: 46,
  },
  bar: {
    width: 4,
    borderRadius: 2,
  },
});
