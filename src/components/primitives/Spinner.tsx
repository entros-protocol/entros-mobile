import { useEffect } from "react";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";

import { useTheme } from "@/theme/ThemeProvider";

interface SpinnerProps {
  size?: number;
  color?: string;
}

export const Spinner = ({ size = 28, color }: SpinnerProps) => {
  const { palette } = useTheme();
  const stroke = color ?? palette.accent;
  const angle = useSharedValue(0);

  useEffect(() => {
    angle.value = withRepeat(withTiming(360, { duration: 900, easing: Easing.linear }), -1, false);
  }, [angle]);

  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${angle.value}deg` }],
  }));

  const r = (size - 4) / 2;

  return (
    <Animated.View style={[{ width: size, height: size }, style]}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Defs>
          <LinearGradient id="grad" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={stroke} stopOpacity={0} />
            <Stop offset="1" stopColor={stroke} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="url(#grad)"
          strokeWidth={2}
          strokeLinecap="round"
          fill="transparent"
          strokeDasharray={`${Math.PI * r * 2 * 0.7} ${Math.PI * r * 2}`}
        />
      </Svg>
    </Animated.View>
  );
};
