import { StyleSheet, View } from "react-native";

import { LockIcon } from "@/components/icons";
import { radii, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

import { Text } from "./Text";

export const PrivacyPill = () => {
  const { palette } = useTheme();
  return (
    <View style={[styles.pill, { backgroundColor: palette.surface, borderColor: palette.border }]}>
      <LockIcon color={palette.accent} size={14} />
      <Text variant="caption" tone="muted">
        Raw signals stay on this device.
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
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignSelf: "center",
  },
});
