// Premium ambient backdrop painted behind every Screen. Three layers stacked
// inside a single absolute container so a Screen's flex children render on
// top untouched:
//
//   1. Static `LinearGradient` painting the background colour shift
//      from top-left → mid → bottom-right. Very low contrast — the goal
//      is depth, not chroma. Stops come from the active palette so the
//      light theme gets a warm neutral wash instead of the dark void.
//
//   2. Static cyan radial bloom anchored top-right at ~22% width offset
//      so it reads as an off-screen light source rather than a centred
//      orb. Implemented as a circular `LinearGradient` from `heroGlow`
//      to transparent — RN doesn't ship a native radial gradient, so we
//      fake it with two crossed linear stops on a circular border-radius.
//
//   3. A second cyan bloom anchored bottom-left at lower opacity, breathed
//      by Reanimated on a slow sine cycle (12 s period, 0.7 → 1.0 opacity).
//      The two glows together create the "alive but quiet" feel.
//
// The whole stack is `pointerEvents="none"` so taps fall through to the
// real content.
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";

import { useTheme } from "@/theme/ThemeProvider";

export const AmbientBackground = () => {
  const { palette } = useTheme();
  const breath = useSharedValue(0);

  useEffect(() => {
    breath.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 6000, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 6000, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(breath);
  }, [breath]);

  const breatheStyle = useAnimatedStyle(() => ({
    opacity: 0.7 + breath.value * 0.3,
  }));

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient
        colors={[palette.gradientStart, palette.gradientMid, palette.gradientEnd]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.glowTopRight]}>
        <LinearGradient
          colors={[palette.heroGlow, "transparent"]}
          start={{ x: 0.5, y: 0.5 }}
          end={{ x: 1, y: 1 }}
          style={styles.glowFill}
        />
      </View>
      <Animated.View style={[styles.glowBottomLeft, breatheStyle]}>
        <LinearGradient
          colors={[palette.heroGlow, "transparent"]}
          start={{ x: 0.5, y: 0.5 }}
          end={{ x: 0, y: 0 }}
          style={styles.glowFill}
        />
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  glowTopRight: {
    position: "absolute",
    top: -160,
    right: -120,
    width: 460,
    height: 460,
    borderRadius: 230,
    overflow: "hidden",
    opacity: 0.55,
  },
  glowBottomLeft: {
    position: "absolute",
    bottom: -200,
    left: -160,
    width: 520,
    height: 520,
    borderRadius: 260,
    overflow: "hidden",
    opacity: 0.45,
  },
  glowFill: { flex: 1 },
});
