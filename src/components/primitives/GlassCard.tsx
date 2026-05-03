// Glassmorphic card. Three stacked layers inside a single rounded clip:
//
//   1. `BlurView` underlay — hardware-accelerated on iOS; on Android it
//      uses the Expo software blur (slow on low-end but acceptable for
//      static cards). When Android can't blur at all we still get a
//      translucent fill from the next layer, so the card reads correct
//      either way.
//
//   2. Low-alpha fill from the active palette — `glassFill` for the
//      default state and `glassFillStrong` (cyan-tinted) for the
//      `glow=true` focus state. Stops the underlying ambient gradient
//      from washing out card text.
//
//   3. Top inner highlight — a hairline LinearGradient from
//      `glassHighlight` to transparent on the top 28% of the card,
//      mimicking the catch-light real glass picks up under ambient
//      illumination. Subtle but it's what sells the effect.
//
// Border + outer cyan shadow follow the original GlowCard contract so
// every existing call-site is a 1:1 swap.
import { ReactNode } from "react";
import { StyleProp, StyleSheet, View, ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";

import { radii, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

interface GlassCardProps {
  children: ReactNode;
  /** Active / focused state — uses a brighter cyan-tinted fill, brighter
   *  border, and a soft outer cyan shadow. Same contract as GlowCard. */
  glow?: boolean;
  padded?: boolean;
  /** Tunable BlurView strength. Default 28 keeps Android software-blur
   *  fast enough on low-end hardware while still reading as glass.
   *  Bump to 50+ on iOS-only for a stronger frosted look. */
  intensity?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export const GlassCard = ({
  children,
  glow = false,
  padded = true,
  intensity = 28,
  style,
  testID,
}: GlassCardProps) => {
  const { palette, mode } = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.card,
        {
          borderColor: glow ? palette.glassBorderStrong : palette.glassBorder,
          padding: padded ? spacing.xl : 0,
          shadowColor: glow ? palette.glow : "transparent",
        },
        glow && styles.cardGlow,
        style,
      ]}
    >
      <BlurView
        intensity={intensity}
        tint={mode === "dark" ? "dark" : "light"}
        style={[StyleSheet.absoluteFill, styles.clip]}
      />
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          styles.clip,
          { backgroundColor: glow ? palette.glassFillStrong : palette.glassFill },
        ]}
      />
      <LinearGradient
        pointerEvents="none"
        colors={[palette.glassHighlight, "transparent"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={[StyleSheet.absoluteFillObject, styles.highlight]}
      />
      <View style={styles.content}>{children}</View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.xl,
    borderWidth: 1,
    overflow: "hidden",
  },
  clip: { borderRadius: radii.xl },
  cardGlow: {
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 24,
    elevation: 6,
  },
  highlight: {
    height: "28%",
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    opacity: 0.55,
  },
  content: { position: "relative" },
});
