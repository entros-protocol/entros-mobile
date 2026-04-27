import { Pressable, StyleSheet, View } from "react-native";

import { radii, spacing } from "@/theme/tokens";
import { ThemePreference, useTheme } from "@/theme/ThemeProvider";

import { Text } from "./Text";

const options: ThemePreference[] = ["system", "dark", "light"];

export const ThemeToggle = () => {
  const { palette, preference, setPreference } = useTheme();
  return (
    <View style={[styles.row, { backgroundColor: palette.surface, borderColor: palette.border }]}>
      {options.map((opt) => {
        const active = preference === opt;
        return (
          <Pressable
            key={opt}
            onPress={() => setPreference(opt)}
            style={[
              styles.cell,
              {
                backgroundColor: active ? palette.accentMuted : "transparent",
              },
            ]}
          >
            <Text
              variant="caption"
              tone={active ? "accent" : "muted"}
              style={{ textTransform: "capitalize" }}
            >
              {opt}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: 3,
    gap: 2,
    alignSelf: "flex-start",
  },
  cell: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
  },
});
