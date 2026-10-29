import { createContext, useContext, useState, type ReactNode } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  View,
  type TextProps,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { nativeColors, nativeMetrics } from "@tidy/design/native-theme";

export const ThemeContext = createContext({
  colors: nativeColors.light,
  font: undefined as string | undefined,
  medium: undefined as string | undefined,
});
export const useTheme = () => useContext(ThemeContext);
export function Text({
  style,
  muted,
  strong,
  ...props
}: TextProps & { muted?: boolean; strong?: boolean }) {
  const { colors, font, medium } = useTheme();
  return (
    <NativeText
      {...props}
      style={[
        {
          color: muted ? colors.muted : colors.ink,
          fontFamily: strong ? medium : font,
          fontSize: 15,
          lineHeight: 22,
        },
        style,
      ]}
    />
  );
}
export function Button({
  label,
  onPress,
  disabled,
  primary,
  danger,
  compact,
  style,
}: {
  label: string;
  onPress(): void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  compact?: boolean;
  style?: ViewStyle;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: nativeMetrics.touchTarget,
          justifyContent: "center",
          alignItems: "center",
          paddingHorizontal: compact ? 12 : 16,
          borderRadius: 8,
          backgroundColor: primary ? colors.action : pressed ? colors.hover : "transparent",
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      <Text
        strong
        style={{ color: primary ? colors.onAction : danger ? colors.danger : colors.ink }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
export function Sheet({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close(): void;
}) {
  const { colors } = useTheme();
  return (
    <Modal
      animationType={Platform.OS === "web" ? "none" : "slide"}
      transparent
      onRequestClose={close}
    >
      <View style={styles.modalBackdrop}>
        <Pressable
          accessibilityLabel="Close panel"
          accessibilityRole="button"
          onPress={close}
          style={StyleSheet.absoluteFill}
        />
        <SafeAreaView
          edges={["bottom", "left", "right"]}
          style={[styles.sheet, { backgroundColor: colors.surface }]}
        >
          <View style={styles.row}>
            <Text strong style={styles.heading}>
              {title}
            </Text>
            <Button label="Done" onPress={close} />
          </View>
          {children}
        </SafeAreaView>
      </View>
    </Modal>
  );
}
export function SelectMenu<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; description?: string; disabled?: boolean }[];
  onChange(value: T): void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  return (
    <>
      <Button
        label={`${label}: ${selected?.label ?? value} ⌄`}
        compact
        onPress={() => setOpen(true)}
      />
      {open && (
        <Sheet title={label} close={() => setOpen(false)}>
          <ScrollView style={{ maxHeight: 400 }}>
            {options.map((option) => (
              <Pressable
                key={option.value}
                accessibilityRole="radio"
                accessibilityState={{
                  checked: value === option.value,
                  disabled: !!option.disabled,
                }}
                disabled={option.disabled}
                onPress={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                style={[styles.option, { opacity: option.disabled ? 0.4 : 1 }]}
              >
                <Text strong>
                  {option.label}
                  {value === option.value ? "  ✓" : ""}
                </Text>
                {option.description && <Text muted>{option.description}</Text>}
              </Pressable>
            ))}
          </ScrollView>
        </Sheet>
      )}
    </>
  );
}
export const styles = StyleSheet.create({
  fill: { flex: 1 },
  page: { flex: 1, width: "100%", maxWidth: nativeMetrics.contentWidth, alignSelf: "center" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  wrap: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 },
  header: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 60,
  },
  heading: { fontSize: 19, lineHeight: 26, flexShrink: 1 },
  title: { fontSize: 30, lineHeight: 38 },
  input: { borderWidth: 1, borderRadius: 10, padding: 14, fontSize: 16, minHeight: 48 },
  option: { paddingHorizontal: 20, paddingVertical: 14, minHeight: 52, gap: 3 },
  modalBackdrop: { flex: 1, backgroundColor: "#00000055", justifyContent: "flex-end" },
  sheet: {
    maxHeight: "85%",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
    gap: 12,
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  empty: { padding: 28, gap: 12 },
});
