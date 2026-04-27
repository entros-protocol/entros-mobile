import { useEffect } from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { ChevronDownIcon } from "@/components/icons";
import { truncate } from "@/lib/format";
import { radii, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

import { Text } from "./Text";

interface AddressBadgeProps {
  address: string | null;
  status?: "connected" | "disconnected" | "pending";
  onPress?: () => void;
}

export const AddressBadge = ({ address, status = "connected", onPress }: AddressBadgeProps) => {
  const { palette } = useTheme();
  const pulse = useSharedValue(0.5);

  useEffect(() => {
    if (status !== "connected") return;
    pulse.value = withRepeat(
      withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse, status]);

  const dotStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  const dotColor =
    status === "connected"
      ? palette.solanaGreen
      : status === "pending"
        ? palette.warning
        : palette.danger;

  const Inner = (
    <View
      pointerEvents="none"
      style={[
        styles.row,
        { borderColor: palette.border, backgroundColor: palette.surface },
        onPress && { borderColor: palette.borderFocus },
      ]}
    >
      <Animated.View style={[styles.dot, { backgroundColor: dotColor }, dotStyle]} />
      <Text variant="monoSmall">{address ? truncate(address, 4, 4) : "Not connected"}</Text>
      {onPress ? <ChevronDownIcon size={14} color={palette.textMuted} /> : null}
    </View>
  );

  if (!onPress) return Inner;

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Wallet menu — copy address, switch, or disconnect"
      onPress={onPress}
      activeOpacity={0.7}
      hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
    >
      {Inner}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
