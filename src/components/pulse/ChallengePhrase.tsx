import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { fontFamily, fontSize, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

import { SectionLabel } from "../primitives/SectionLabel";

interface ChallengePhraseProps {
  phrase: string;
  active?: boolean;
}

export const ChallengePhrase = ({ phrase, active = true }: ChallengePhraseProps) => {
  const { palette } = useTheme();
  const glow = useSharedValue(0);

  useEffect(() => {
    if (!active) {
      glow.value = 0;
      return;
    }
    glow.value = withRepeat(
      withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [active, glow]);

  const phraseStyle = useAnimatedStyle(() => ({
    textShadowRadius: 6 + glow.value * 14,
    opacity: 0.78 + glow.value * 0.22,
  }));

  return (
    <View style={styles.wrap}>
      <SectionLabel>SPEAK</SectionLabel>
      <Animated.Text
        style={[
          styles.phrase,
          {
            color: palette.text,
            fontFamily: fontFamily.bold,
            textShadowColor: palette.accent,
          },
          phraseStyle,
        ]}
      >
        “{phrase}”
      </Animated.Text>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    gap: spacing.md,
    alignItems: "center",
  },
  phrase: {
    fontSize: fontSize.heading,
    lineHeight: fontSize.heading * 1.3,
    textAlign: "center",
    paddingHorizontal: spacing.lg,
    textShadowOffset: { width: 0, height: 0 },
  },
});
