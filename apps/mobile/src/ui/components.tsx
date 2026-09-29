import React, { useState } from 'react';
import {
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
export const money = (value: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
export const dateLabel = (value: string) => value.split('-').reverse().join('/');
export function Button({
  label,
  onPress,
  disabled = false,
  tone = 'normal',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'normal' | 'primary' | 'danger';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, tone === 'primary' && styles.primary, disabled && styles.disabled]}
    >
      <Text style={[styles.buttonText, tone === 'danger' && styles.danger]}>{label}</Text>
    </Pressable>
  );
}
export function Field({
  label,
  value,
  onChange,
  numeric = false,
  multiline = false,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  numeric?: boolean;
  multiline?: boolean;
  hint?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        multiline={multiline}
        placeholder={hint}
        placeholderTextColor="#798299"
        style={[styles.input, multiline && { minHeight: 80 }]}
      />
      {hint && <Text style={styles.muted}>{hint}</Text>}
    </View>
  );
}
export function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Button
        label={`${label}: ${options.find((o) => o.value === value)?.label ?? 'Selecionar'} ▾`}
        onPress={() => {
          Keyboard.dismiss();
          setOpen(true);
        }}
      />
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.safe}>
          <View style={styles.content}>
            <Text style={styles.title}>{label}</Text>
            <Button label="Voltar" onPress={() => setOpen(false)} />
          </View>
          <ScrollView contentContainerStyle={styles.content}>
            {options.map((o) => (
              <Pressable
                key={o.value}
                accessibilityRole="radio"
                accessibilityLabel={o.label}
                accessibilityState={{ checked: o.value === value }}
                style={[styles.button, o.value === value && styles.primary]}
                onPress={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <Text style={styles.buttonText}>
                  {o.label}
                  {o.value === value ? ' ✓' : ''}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </View>
  );
}
export const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#10151f' },
  content: { padding: 20, gap: 14 },
  card: {
    backgroundColor: '#1b2331',
    borderColor: '#2b3547',
    borderWidth: 1,
    borderRadius: 18,
    padding: 18,
    gap: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  title: { color: '#f4f6fc', fontSize: 28, fontWeight: '700' },
  heading: { color: '#f4f6fc', fontSize: 19, fontWeight: '700' },
  text: { color: '#eef1f8', fontSize: 16 },
  muted: { color: '#a6b1c7', fontSize: 13, lineHeight: 19 },
  label: { color: '#cbd4e5', fontSize: 14, fontWeight: '600' },
  button: {
    backgroundColor: '#273247',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 48,
    justifyContent: 'center',
  },
  buttonText: { color: '#f4f6fc', fontSize: 15, fontWeight: '600' },
  primary: { backgroundColor: '#5b4cbd' },
  disabled: { opacity: 0.5 },
  positive: { color: '#7bddb4' },
  danger: { color: '#ff9caa' },
  field: { gap: 8 },
  input: {
    color: '#f4f6fc',
    backgroundColor: '#1b2331',
    borderWidth: 1,
    borderColor: '#3d4860',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    minHeight: 50,
  },
  error: {
    color: '#ffb0bb',
    backgroundColor: '#3c202d',
    borderRadius: 12,
    padding: 14,
  },
});
