import { useRouter } from "expo-router";
import { Pressable, StyleSheet } from "react-native";

import { ChevronLeftIcon } from "@/components/icons";
import { useTheme } from "@/theme/ThemeProvider";

export const BackButton = ({ onPress }: { onPress?: () => void }) => {
  const router = useRouter();
  const { palette } = useTheme();
  const handlePress = onPress ?? (() => router.back());
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      hitSlop={12}
      onPress={handlePress}
      style={({ pressed }) => [styles.btn, pressed && { opacity: 0.5 }]}
    >
      <ChevronLeftIcon size={22} color={palette.text} />
    </Pressable>
  );
};

const styles = StyleSheet.create({
  btn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -8,
  },
});
