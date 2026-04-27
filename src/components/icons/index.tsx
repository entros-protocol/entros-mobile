// Hand-rolled SVG icons. We avoid icon-pack deps for the scaffold so the bundle
// stays minimal and the visual language stays under our control.
import Svg, { Path, Polyline, Rect, Circle, Line } from "react-native-svg";

interface IconProps {
  size?: number;
  color?: string;
  strokeWidth?: number;
}

const defaults = { size: 20, strokeWidth: 1.6 } as const;

export const CheckIcon = ({
  size = defaults.size,
  color = "#14F195",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Polyline
      points="4,12.5 10,18 20,6"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const AlertIcon = ({
  size = defaults.size,
  color = "#FF3B3B",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M12 3 L22 20 L2 20 Z"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinejoin="round"
    />
    <Line
      x1="12"
      y1="10"
      x2="12"
      y2="14"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
    <Circle cx="12" cy="17" r="0.8" fill={color} />
  </Svg>
);

export const LockIcon = ({
  size = defaults.size,
  color = "#22D3E6",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Rect x="5" y="11" width="14" height="9" rx="2" stroke={color} strokeWidth={strokeWidth} />
    <Path
      d="M8 11 V8 a4 4 0 0 1 8 0 V11"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
  </Svg>
);

export const WalletIcon = ({
  size = defaults.size,
  color = "#22D3E6",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Rect x="3" y="6" width="18" height="14" rx="2" stroke={color} strokeWidth={strokeWidth} />
    <Path
      d="M3 10 H17 a2 2 0 0 1 2 2 v0 a2 2 0 0 1 -2 2 H3"
      stroke={color}
      strokeWidth={strokeWidth}
    />
    <Circle cx="16" cy="13" r="0.8" fill={color} />
  </Svg>
);

export const ChevronRightIcon = ({
  size = defaults.size,
  color = "#E8E6E0",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Polyline
      points="9,5 16,12 9,19"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const ChevronLeftIcon = ({
  size = defaults.size,
  color = "#E8E6E0",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Polyline
      points="15,5 8,12 15,19"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const ChevronDownIcon = ({
  size = defaults.size,
  color = "#E8E6E0",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Polyline
      points="5,9 12,16 19,9"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const LogoutIcon = ({
  size = defaults.size,
  color = "#FF3B3B",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M9 21H5a2 2 0 0 1 -2 -2 V5 a2 2 0 0 1 2 -2 h4"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <Polyline
      points="16,17 21,12 16,7"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <Line
      x1="21"
      y1="12"
      x2="9"
      y2="12"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
  </Svg>
);

export const MicIcon = ({
  size = defaults.size,
  color = "#22D3E6",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Rect x="9" y="3" width="6" height="12" rx="3" stroke={color} strokeWidth={strokeWidth} />
    <Path
      d="M5 11 v1 a7 7 0 0 0 14 0 v-1"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
    <Line
      x1="12"
      y1="19"
      x2="12"
      y2="22"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
  </Svg>
);

export const MotionIcon = ({
  size = defaults.size,
  color = "#A855F7",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Circle cx="12" cy="12" r="3" stroke={color} strokeWidth={strokeWidth} />
    <Path
      d="M5 5 a10 10 0 0 1 14 0"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      opacity="0.45"
    />
    <Path
      d="M3 9 a14 14 0 0 1 18 0"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      opacity="0.25"
    />
  </Svg>
);

export const TouchIcon = ({
  size = defaults.size,
  color = "#14F195",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M9 11 V6 a2 2 0 1 1 4 0 v6 m0 -3 a2 2 0 1 1 4 0 v3 m0 -1 a2 2 0 1 1 4 0 v3 a6 6 0 0 1 -6 6 H11 a4 4 0 0 1 -4 -4 v-2 l-3 -3 a2 2 0 0 1 3 -3 l2 2"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const SparkleIcon = ({
  size = defaults.size,
  color = "#22D3E6",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M12 2 L13.5 9 L21 10.5 L13.5 12 L12 19 L10.5 12 L3 10.5 L10.5 9 Z"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinejoin="round"
    />
  </Svg>
);

export const RefreshIcon = ({
  size = defaults.size,
  color = "#22D3E6",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M3 12 a9 9 0 0 1 15.5 -6.3 L21 8"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
    <Polyline
      points="21,3 21,8 16,8"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <Path
      d="M21 12 a9 9 0 0 1 -15.5 6.3 L3 16"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
    <Polyline
      points="3,21 3,16 8,16"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const SettingsIcon = ({
  size = defaults.size,
  color = "#E8E6E0",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Circle cx="12" cy="12" r="3" stroke={color} strokeWidth={strokeWidth} />
    <Path
      d="M19 15 a1.7 1.7 0 0 0 .35 1.85 l.06 .07 a2 2 0 1 1 -2.83 2.83 l-.07 -.06 a1.7 1.7 0 0 0 -1.85 -.35 a1.7 1.7 0 0 0 -1.05 1.55 V20.5 a2 2 0 0 1 -4 0 v-.07 a1.7 1.7 0 0 0 -1.05 -1.55 a1.7 1.7 0 0 0 -1.85 .35 l-.07 .06 a2 2 0 1 1 -2.83 -2.83 l.06 -.07 a1.7 1.7 0 0 0 .35 -1.85 a1.7 1.7 0 0 0 -1.55 -1.05 H3.5 a2 2 0 0 1 0 -4 h.07 a1.7 1.7 0 0 0 1.55 -1.05 a1.7 1.7 0 0 0 -.35 -1.85 l-.06 -.07 a2 2 0 1 1 2.83 -2.83 l.07 .06 a1.7 1.7 0 0 0 1.85 .35 H10 a1.7 1.7 0 0 0 1 -1.55 V3.5 a2 2 0 0 1 4 0 v.07 a1.7 1.7 0 0 0 1 1.55 a1.7 1.7 0 0 0 1.85 -.35 l.07 -.06 a2 2 0 1 1 2.83 2.83 l-.06 .07 a1.7 1.7 0 0 0 -.35 1.85 V10 a1.7 1.7 0 0 0 1.55 1 H20.5 a2 2 0 0 1 0 4 h-.07 a1.7 1.7 0 0 0 -1.55 1 z"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinejoin="round"
    />
  </Svg>
);

export const ListIcon = ({
  size = defaults.size,
  color = "#E8E6E0",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Line
      x1="3"
      y1="6"
      x2="21"
      y2="6"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
    <Line
      x1="3"
      y1="12"
      x2="21"
      y2="12"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
    <Line
      x1="3"
      y1="18"
      x2="21"
      y2="18"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
  </Svg>
);

export const HomeIcon = ({
  size = defaults.size,
  color = "#E8E6E0",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M3 11 L12 3 L21 11 V20 a1 1 0 0 1 -1 1 H15 V14 H9 V21 H4 a1 1 0 0 1 -1 -1 z"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  </Svg>
);

export const ExternalIcon = ({
  size = defaults.size,
  color = "#22D3E6",
  strokeWidth = defaults.strokeWidth,
}: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M14 4 H20 V10"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <Line
      x1="20"
      y1="4"
      x2="11"
      y2="13"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
    <Path
      d="M19 14 V19 a1 1 0 0 1 -1 1 H5 a1 1 0 0 1 -1 -1 V6 a1 1 0 0 1 1 -1 h5"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
  </Svg>
);
