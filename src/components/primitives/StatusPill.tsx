import { StyleSheet, View } from "react-native";

import { fontFamily, fontSize, radii, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

import { Text } from "./Text";

type Status = "verified" | "unverified" | "failed" | "pending";

interface StatusPillProps {
  status: Status;
  label?: string;
}

/** Status pill — small sentence-case badge with a leading dot. Sentence-case
 *  (rather than uppercase + heavy letter-spacing) is what kept "Unverified"
 *  from clipping on the dashboard, and it reads as more refined alongside
 *  Inter body copy than the ALL-CAPS treatment of the prior version. */
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
          backgroundColor: `${color}12`,
        },
      ]}
    >
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]} numberOfLines={1}>
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
    paddingVertical: 5,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  label: {
    fontFamily: fontFamily.medium,
    fontSize: fontSize.caption,
    lineHeight: fontSize.caption * 1.2,
    letterSpacing: 0.1,
  },
});
