import { Text } from "./Text";

interface SectionLabelProps {
  children: string;
  tone?: "accent" | "muted" | "default";
}

export const SectionLabel = ({ children, tone = "accent" }: SectionLabelProps) => (
  <Text variant="label" tone={tone}>
    {`// ${children.replace(/^\/\/\s*/, "")}`}
  </Text>
);
