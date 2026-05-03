// Soft cyan radial bloom rendered behind hero content (welcome wordmark,
// dashboard score). Implemented as an overflow-clipped circle with a
// LinearGradient from `heroGlow` to transparent radiating from the centre
// toward each corner — RN ships no native radial-gradient primitive so we
// fake it with an ovaling box-shadow + linear stops trick.
//
// The circle breathes on a 7s sine cycle (opacity 0.55 → 1.0) so the hero
// reads as alive without ever pulling focus from the text on top. The
// animation is GPU-cheap: a single Animated.View opacity worklet, no
// layout thrash.
//
// Renders absolutely below its sibling content. Wrap your hero block in
// a relative-positioned parent and drop a HeroGlow as the first child —
// the parent's content will render on top.
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

interface HeroGlowProps {
  /** Diameter in points. Default 280 sits comfortably behind a 64pt
   *  EntrosLogo + the section label below it. */
  size?: number;
  /** Vertical offset from the parent's top edge. Default centres on the
   *  parent's first ~40% of height (typical hero region). */
  topOffset?: number;
}

export const HeroGlow = ({ size = 280, topOffset = 0 }: HeroGlowProps) => {
  const { palette } = useTheme();
  const breath = useSharedValue(0);

  useEffect(() => {
    breath.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 3500, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 3500, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(breath);
  }, [breath]);

  const breathStyle = useAnimatedStyle(() => ({
    opacity: 0.55 + breath.value * 0.45,
    transform: [{ scale: 0.96 + breath.value * 0.08 }],
  }));

  return (
    <View
      pointerEvents="none"
      style={[
        styles.wrap,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          marginLeft: -size / 2,
          top: topOffset,
        },
      ]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, breathStyle]}>
        <LinearGradient
          colors={[palette.heroGlow, "transparent"]}
          start={{ x: 0.5, y: 0.5 }}
          end={{ x: 0, y: 0 }}
          style={styles.fill}
        />
        <LinearGradient
          colors={[palette.heroGlow, "transparent"]}
          start={{ x: 0.5, y: 0.5 }}
          end={{ x: 1, y: 1 }}
          style={[StyleSheet.absoluteFill, styles.fill]}
        />
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: "50%",
    overflow: "hidden",
  },
  fill: { flex: 1 },
});
