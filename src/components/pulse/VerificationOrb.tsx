import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { useTheme } from "@/theme/ThemeProvider";

interface VerificationOrbProps {
  size?: number;
}

export const VerificationOrb = ({ size = 140 }: VerificationOrbProps) => {
  const { palette } = useTheme();
  const pulse = useSharedValue(0);

  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(1, { duration: 2400, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse]);

  const innerStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 0.92 + pulse.value * 0.16 }],
    opacity: 0.55 + pulse.value * 0.4,
  }));
  const outerStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + pulse.value * 0.4 }],
    opacity: 0.18 - pulse.value * 0.18,
  }));

  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <Animated.View
        style={[
          styles.layer,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: palette.accent,
          },
          outerStyle,
        ]}
      />
      <Animated.View
        style={[
          styles.layer,
          {
            width: size * 0.6,
            height: size * 0.6,
            borderRadius: (size * 0.6) / 2,
            backgroundColor: palette.accent,
          },
          innerStyle,
        ]}
      />
      <View
        style={[
          styles.core,
          {
            width: size * 0.32,
            height: size * 0.32,
            borderRadius: (size * 0.32) / 2,
            backgroundColor: palette.text,
            shadowColor: palette.accent,
          },
        ]}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  layer: {
    position: "absolute",
  },
  core: {
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 24,
  },
});
