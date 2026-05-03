import { useRouter } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { MicIcon, MotionIcon, TouchIcon } from "@/components/icons";
import { Button } from "@/components/primitives/Button";
import { EntrosLogo } from "@/components/primitives/EntrosLogo";
import { GlassCard } from "@/components/primitives/GlassCard";
import { HeroGlow } from "@/components/primitives/HeroGlow";
import { ProgressDots } from "@/components/primitives/ProgressDots";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Text } from "@/components/primitives/Text";
import { useAppState } from "@/state/AppState";
import { fontFamily, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

type ModalityKind = "voice" | "motion" | "touch";

const modalities: {
  kind: ModalityKind;
  Icon: React.FC<{ size?: number; color?: string }>;
  title: string;
  body: string;
}[] = [
  { kind: "voice", Icon: MicIcon, title: "Voice", body: "Pitch, cadence, breath." },
  { kind: "motion", Icon: MotionIcon, title: "Motion", body: "How you hold the phone." },
  { kind: "touch", Icon: TouchIcon, title: "Touch", body: "How you tap and trace." },
];

/** Per-modality subtle ambient animation. Each runs on its own cadence so
 *  the three rows feel alive but don't sync up into a distracting pulse.
 *  All durations are slow (1.6–2.4s per cycle) and opacity stays high so
 *  the motion reads as breathing, not blinking. Animations cancel on unmount. */
function useModalityAnimation(kind: ModalityKind) {
  const value = useSharedValue(0);

  useEffect(() => {
    if (kind === "voice") {
      // Voice — slow opacity + scale pulse evoking breath rhythm.
      value.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 1100, easing: Easing.out(Easing.quad) }),
          withTiming(0, { duration: 1100, easing: Easing.in(Easing.quad) }),
        ),
        -1,
        false,
      );
    } else if (kind === "motion") {
      // Motion — subtle tilt oscillation. The icon already renders at
      // -15° via SVG transform; this animates between -1 (extra tilt left)
      // and +1 (extra tilt right) for a gentle wobble.
      value.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.sin) }),
          withTiming(-1, { duration: 1400, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      );
    } else {
      // Touch — staggered ripple. value cycles 0→1 with a brief hold at
      // 1 to suggest a tap landing, then quickly resets.
      value.value = withDelay(
        300,
        withRepeat(
          withSequence(
            withTiming(1, { duration: 800, easing: Easing.out(Easing.quad) }),
            withTiming(0, { duration: 600, easing: Easing.linear }),
          ),
          -1,
          false,
        ),
      );
    }
    return () => cancelAnimation(value);
  }, [kind, value]);

  return useAnimatedStyle(() => {
    if (kind === "voice") {
      return {
        opacity: 0.7 + value.value * 0.3,
        transform: [{ scale: 1 + value.value * 0.08 }],
      };
    }
    if (kind === "motion") {
      return { transform: [{ rotate: `${value.value * 4}deg` }] };
    }
    // touch — outer ripple radial scale + inner dot fade
    return {
      transform: [{ scale: 0.9 + value.value * 0.18 }],
      opacity: 0.65 + value.value * 0.35,
    };
  });
}

const ModalityIcon = ({
  kind,
  Icon,
  color,
  size,
}: {
  kind: ModalityKind;
  Icon: React.FC<{ size?: number; color?: string }>;
  color: string;
  size: number;
}) => {
  const animStyle = useModalityAnimation(kind);
  return (
    <Animated.View style={animStyle}>
      <Icon size={size} color={color} />
    </Animated.View>
  );
};

export default function Welcome() {
  const router = useRouter();
  const { palette } = useTheme();
  const { connection } = useAppState();
  const isRevisit = connection.connected;

  return (
    <Screen>
      <View style={styles.wrap}>
        {/* The body block flexes to fill all space between the (empty) top
            and the fixed footer, with its content vertically centered.
            Onboarding content is short enough that this looks like it
            "rises from the middle" instead of stacking from the top. */}
        <View style={styles.body}>
          <View style={styles.hero}>
            <HeroGlow size={300} topOffset={-120} />
            <EntrosLogo size={48} />
            <View style={styles.titleBlock}>
              <SectionLabel>WELCOME</SectionLabel>
              <Text variant="title" align="center">
                Proof of Personhood,{"\n"}built for Solana.
              </Text>
              <Text variant="body" tone="muted" align="center">
                Proves you're still you, every time.
              </Text>
            </View>
          </View>

          <View style={styles.rows}>
            {modalities.map(({ kind, Icon, title, body }) => (
              <GlassCard key={title} padded={false} style={styles.row}>
                <View style={[styles.iconWrap, { borderColor: palette.glassBorderStrong }]}>
                  <View style={[styles.iconWrapInner, { backgroundColor: palette.accentMuted }]}>
                    <ModalityIcon kind={kind} Icon={Icon} color={palette.accent} size={20} />
                  </View>
                </View>
                <View style={styles.rowText}>
                  <Text style={[styles.rowTitle, { color: palette.text }]}>{title}</Text>
                  <Text variant="caption" tone="muted">
                    {body}
                  </Text>
                </View>
              </GlassCard>
            ))}
          </View>
        </View>

        <View style={styles.footer}>
          {isRevisit ? null : <ProgressDots total={3} active={0} />}
          <Button label="Continue" onPress={() => router.push("/(onboard)/privacy")} />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    paddingBottom: spacing.lg,
  },
  body: {
    flex: 1,
    justifyContent: "center",
    gap: spacing.xxl,
  },
  hero: { alignItems: "center", gap: spacing.lg, position: "relative" },
  titleBlock: { gap: spacing.sm, alignItems: "center" },
  rows: { gap: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  // Glass modality disc — outer hairline cyan border + inner cyan-tinted fill
  // wrapping the icon. Reads as a small lit panel rather than a flat circle.
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  iconWrapInner: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: {
    fontFamily: fontFamily.semiBold,
    fontSize: 17,
    letterSpacing: -0.1,
  },
  footer: { gap: spacing.lg, alignItems: "stretch" },
});
