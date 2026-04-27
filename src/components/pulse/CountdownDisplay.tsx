import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useEffect } from "react";

import { fontFamily, fontSize, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

import { SectionLabel } from "../primitives/SectionLabel";
import { Text } from "../primitives/Text";

interface CountdownDisplayProps {
  value: number;
  total?: number;
}

export const CountdownDisplay = ({ value, total = 3 }: CountdownDisplayProps) => {
  const { palette } = useTheme();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = 0;
    progress.value = withTiming(1, { duration: 600, easing: Easing.out(Easing.cubic) });
  }, [value, progress]);

  const numberStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(progress.value, [0, 1], [1.4, 1]) }],
    opacity: progress.value,
  }));

  return (
    <View style={styles.wrap}>
      <SectionLabel>STARTING IN</SectionLabel>
      <Animated.Text
        style={[styles.number, { color: palette.accent, fontFamily: fontFamily.bold }, numberStyle]}
      >
        {value > 0 ? value : "GO"}
      </Animated.Text>
      <Text variant="caption" tone="muted">
        Step {Math.min(total - value + 1, total)} of {total}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xl,
  },
  number: {
    fontSize: fontSize.hero * 2,
    lineHeight: fontSize.hero * 2,
    letterSpacing: -2,
  },
});
