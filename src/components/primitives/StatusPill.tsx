import { StyleSheet, View } from "react-native";

import { radii, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

import { Text } from "./Text";

type Status = "verified" | "unverified" | "failed" | "pending";

interface StatusPillProps {
  status: Status;
  label?: string;
}

export const StatusPill = ({ status, label }: StatusPillProps) => {
  const { palette } = useTheme();
  const config: Record<Status, { color: string; label: string }> = {
    verified: { color: palette.solanaGreen, label: "Verified" },
    unverified: { color: palette.textMuted, label: "Unverified" },
    failed: { color: palette.danger, label: "Failed" },
    pending: { color: palette.warning, label: "Pending" },
  };
  const { color, label: defaultLabel } = config[status];

  return (
    <View
      style={[
        styles.pill,
        {
          borderColor: color,
          backgroundColor: `${color}15`,
        },
      ]}
    >
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text variant="label" style={{ color, letterSpacing: 1.2 }}>
        {label ?? defaultLabel}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
