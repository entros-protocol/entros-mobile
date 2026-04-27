import { StyleSheet, View } from "react-native";

import { spacing } from "@/theme/tokens";

import { Spinner } from "../primitives/Spinner";
import { Text } from "../primitives/Text";

interface ProcessingStageProps {
  title: string;
  subtitle?: string;
  spinnerColor?: string;
}

export const ProcessingStage = ({ title, subtitle, spinnerColor }: ProcessingStageProps) => (
  <View style={styles.wrap}>
    <Spinner size={36} color={spinnerColor} />
    <Text variant="heading" align="center">
      {title}
    </Text>
    {subtitle ? (
      <Text variant="body" tone="muted" align="center">
        {subtitle}
      </Text>
    ) : null}
  </View>
);

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xl,
    paddingHorizontal: spacing.xl,
  },
});
