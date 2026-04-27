import { StyleSheet, View } from "react-native";

import { radii, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

interface ProgressDotsProps {
  total: number;
  active: number;
}

export const ProgressDots = ({ total, active }: ProgressDotsProps) => {
  const { palette } = useTheme();
  return (
    <View style={styles.row}>
      {Array.from({ length: total }).map((_, i) => {
        const isActive = i === active;
        const isPast = i < active;
        return (
          <View
            key={i}
            style={[
              styles.dot,
              {
                width: isActive ? 24 : 6,
                backgroundColor: isPast || isActive ? palette.accent : palette.textSubtle,
                opacity: isActive ? 1 : isPast ? 0.7 : 0.3,
              },
            ]}
          />
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  dot: {
    height: 6,
    borderRadius: radii.pill,
  },
});
