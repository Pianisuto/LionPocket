import { useAppearance } from './Appearance';
import React, { useMemo, useRef, useState } from 'react';
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
import { fonts, type Palette } from './theme';
import { Icon, type IconName } from './Icon';
import {
  currentMonthIso,
  isValidDate,
  todayIso,
  validateMonth,
} from '@lionpocket/core';
import { nativeUi } from './native';
export const money = (value: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
    value,
  );
export const dateLabel = (value: string) =>
  value.split('-').reverse().join('/');
export function Button({
  label,
  onPress,
  disabled = false,
  tone = 'normal',
  icon,
  compact = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'normal' | 'primary' | 'danger';
  icon?: IconName;
  compact?: boolean;
}) {
  const styles = useStyles();
  const { colors } = useAppearance();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.compact,
        tone === 'primary' && styles.primary,
        tone === 'danger' && styles.dangerButton,
        disabled && styles.disabled,
        pressed && { opacity: 0.72 },
      ]}
    >
      {icon && (
        <Icon
          name={icon}
          color={
            tone === 'primary'
              ? colors.onPrimary
              : tone === 'danger'
                ? colors.alert
                : colors.soft
          }
        />
      )}
      <Text
        style={[
          styles.buttonText,
          tone === 'primary' && { color: colors.onPrimary },
          tone === 'danger' && { color: colors.alert },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}
export function IconButton({
  label,
  icon,
  onPress,
  disabled = false,
  active = false,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  const styles = useStyles();
  const { colors } = useAppearance();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        active && { backgroundColor: colors.primaryWash },
        disabled && styles.disabled,
        pressed && { opacity: 0.65 },
      ]}
    >
      <Icon name={icon} color={active ? colors.primaryInk : colors.soft} />
    </Pressable>
  );
}
export function ScreenHeader({
  title,
  subtitle,
  onClose,
  disabled = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  disabled?: boolean;
}) {
  const styles = useStyles();
  return (
    <View style={styles.screenHeader}>
      <View style={{ flex: 1, gap: 4 }}>
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        {subtitle && <Text style={styles.muted}>{subtitle}</Text>}
      </View>
      <IconButton
        label="Fechar"
        icon="close"
        disabled={disabled}
        onPress={onClose}
      />
    </View>
  );
}
export function Sheet({
  footer,
  title,
  onClose,
  children,
  disabled = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  disabled?: boolean;
}) {
  const styles = useStyles();
  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={() => {
        if (!disabled) onClose();
      }}
      statusBarTranslucent
    >
      <View style={styles.sheetBackdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel="Fechar painel"
          disabled={disabled}
          onPress={onClose}
        />
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <ScreenHeader title={title} onClose={onClose} disabled={disabled} />
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.content}
          >
            {children}
          </ScrollView>
          {footer && <View style={styles.formFooter}>{footer}</View>}
        </SafeAreaView>
      </View>
    </Modal>
  );
}
export function Field({
  label,
  value,
  onChange,
  numeric = false,
  prominent = false,
  multiline = false,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  numeric?: boolean;
  prominent?: boolean;
  multiline?: boolean;
  hint?: string;
}) {
  const styles = useStyles();
  const { colors } = useAppearance();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        multiline={multiline}
        placeholder={hint && hint.length < 45 ? hint : undefined}
        placeholderTextColor={colors.muted}
        selectionColor={colors.primary}
        style={[
          styles.input,
          prominent && {
            fontFamily: fonts.display,
            fontSize: 30,
            color: colors.primaryInk,
            minHeight: 72,
          },
          multiline && { minHeight: 88, textAlignVertical: 'top' },
        ]}
      />
      {hint && <Text style={styles.muted}>{hint}</Text>}
    </View>
  );
}
export function Choice({
  inline = false,
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  inline?: boolean;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const styles = useStyles();
  const { colors } = useAppearance();
  const [open, setOpen] = useState(false);
  if (inline)
    return (
      <View style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {options.map((option) => (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={`${label}: ${option.label}`}
              accessibilityState={{ checked: value === option.value }}
              onPress={() => onChange(option.value)}
              style={[
                styles.option,
                { flex: 1, justifyContent: 'center' },
                value === option.value && {
                  backgroundColor: colors.primaryWash,
                  borderColor: colors.primary,
                },
              ]}
            >
              <Text
                style={[
                  styles.buttonText,
                  { textAlign: 'center' },
                  value === option.value && { color: colors.primaryInk },
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    );

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${options.find((o) => o.value === value)?.label ?? 'Selecionar'}`}
        onPress={() => {
          Keyboard.dismiss();
          setOpen(true);
        }}
        style={styles.select}
      >
        <Text style={[styles.text, { flex: 1 }]}>
          {options.find((o) => o.value === value)?.label ?? 'Selecionar'}
        </Text>
        <Icon name="down" size={18} />
      </Pressable>
      {open && (
        <Sheet title={label} onClose={() => setOpen(false)}>
          {options.map((o) => (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityLabel={o.label}
              accessibilityState={{ checked: o.value === value }}
              style={[
                styles.option,
                o.value === value && {
                  backgroundColor: colors.primaryWash,
                  borderColor: colors.primary,
                },
              ]}
              onPress={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <Text
                style={[
                  styles.text,
                  { flex: 1 },
                  o.value === value && { color: colors.primaryInk },
                ]}
              >
                {o.label}
              </Text>
              {o.value === value && (
                <Icon name="check" color={colors.primaryInk} />
              )}
            </Pressable>
          ))}
        </Sheet>
      )}
    </View>
  );
}
const createStyles = (colors: Palette) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 20, gap: 16 },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.line,
      borderWidth: 1,
      borderRadius: 20,
      padding: 18,
      gap: 12,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      flexWrap: 'wrap',
    },
    title: {
      color: colors.text,
      fontSize: 28,
      fontFamily: fonts.display,
      letterSpacing: -0.6,
    },
    heading: {
      color: colors.text,
      fontSize: 19,
      fontFamily: fonts.display,
      letterSpacing: -0.3,
    },
    text: {
      color: colors.text,
      fontSize: 15,
      fontFamily: fonts.ui,
      lineHeight: 22,
    },
    muted: {
      color: colors.muted,
      fontSize: 12,
      fontFamily: fonts.ui,
      lineHeight: 18,
    },
    label: { color: colors.soft, fontSize: 13, fontFamily: fonts.medium },
    button: {
      backgroundColor: colors.surface2,
      borderColor: colors.lineStrong,
      borderWidth: 1,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 12,
      minHeight: 48,
      flexDirection: 'row',
      gap: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    compact: { paddingHorizontal: 12, paddingVertical: 10 },
    buttonText: {
      color: colors.text,
      fontSize: 14,
      fontFamily: fonts.bold,
      flexShrink: 1,
    },
    primary: { backgroundColor: colors.primary, borderColor: colors.primary },
    dangerButton: {
      backgroundColor: colors.alertWash,
      borderColor: colors.alertWash,
    },
    disabled: { opacity: 0.45 },
    positive: { color: colors.positive, fontFamily: fonts.medium },
    danger: { color: colors.negative, fontFamily: fonts.medium },
    field: { gap: 8 },
    input: {
      color: colors.text,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: 14,
      padding: 14,
      fontSize: 16,
      fontFamily: fonts.ui,
      minHeight: 52,
    },
    error: {
      color: colors.alert,
      backgroundColor: colors.alertWash,
      borderRadius: 14,
      padding: 14,
      fontFamily: fonts.ui,
      lineHeight: 21,
    },
    iconButton: {
      width: 48,
      height: 48,
      borderRadius: 14,
      backgroundColor: colors.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    formFooter: {
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderTopWidth: 1,
      borderTopColor: colors.line,
      backgroundColor: colors.bg,
    },
    screenHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 20,
      paddingVertical: 16,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    select: {
      flexDirection: 'row',
      gap: 12,
      alignItems: 'center',
      padding: 14,
      minHeight: 52,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface,
    },
    sheetBackdrop: {
      flex: 1,
      backgroundColor: '#00000099',
      justifyContent: 'flex-end',
    },
    sheet: {
      maxHeight: '90%',
      backgroundColor: colors.bg,
      borderTopLeftRadius: 26,
      borderTopRightRadius: 26,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      overflow: 'hidden',
    },
    sheetHandle: {
      width: 36,
      height: 4,
      marginTop: 10,
      alignSelf: 'center',
      borderRadius: 2,
      backgroundColor: colors.lineStrong,
    },
    option: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      minHeight: 52,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 14,
      backgroundColor: colors.surface,
    },
  });

export function useStyles() {
  const { colors } = useAppearance();
  return useMemo(() => createStyles(colors), [colors]);
}

export function DateField({
  label,
  value,
  onChange,
  optional = false,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
  hint?: string;
}) {
  const styles = useStyles();
  const { preferences } = useAppearance();
  const [error, setError] = useState('');
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const pick = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    Keyboard.dismiss();
    try {
      const next = await nativeUi.pickDate(
        isValidDate(value) ? value : todayIso(),
        preferences.theme === 'light',
      );
      if (next) onChange(next);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível abrir o calendário.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value ? dateLabel(value) : 'Sem data'}. Abrir calendário`}
        disabled={busy}
        style={styles.select}
        onPress={() => void pick()}
      >
        <Text style={[styles.text, { flex: 1 }]}>
          {value ? dateLabel(value) : 'Selecionar data'}
        </Text>
        <Icon name="calendar" />
      </Pressable>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Digitar ${label.toLocaleLowerCase('pt-BR')}`}
          onPress={() => {
            setDraft(value);
            setManual(true);
          }}
          style={{ minHeight: 36, justifyContent: 'center' }}
        >
          <Text style={styles.muted}>Digitar data</Text>
        </Pressable>
        {optional && value && (
          <Button compact label="Limpar data" onPress={() => onChange('')} />
        )}
      </View>
      {!!hint && <Text style={styles.muted}>{hint}</Text>}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {manual && (
        <Sheet title={label} onClose={() => setManual(false)}>
          <Field
            label="Data (AAAA-MM-DD)"
            value={draft}
            onChange={setDraft}
            hint="Ex.: 2026-09-29"
          />
          <Button
            label="Aplicar data"
            tone="primary"
            onPress={() => {
              if (isValidDate(draft) || (optional && !draft)) {
                onChange(draft);
                setManual(false);
                setError('');
              } else setError('Informe uma data válida (AAAA-MM-DD).');
            }}
          />
          {!!error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
        </Sheet>
      )}
    </View>
  );
}

export function MonthPicker({
  month,
  onChange,
  onClose,
}: {
  month: string;
  onChange: (month: string) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const [year, setYear] = useState(month.slice(0, 4));
  const [error, setError] = useState('');
  const choose = (next: string) => {
    try {
      validateMonth(next);
      onChange(next);
      onClose();
    } catch {
      setError('Informe um ano entre 1000 e 9999.');
    }
  };
  return (
    <Sheet title="Escolher mês" onClose={onClose}>
      <Field
        label="Ano"
        numeric
        value={year}
        onChange={(value) => {
          setYear(value);
          setError('');
        }}
      />
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <View style={[styles.row, { alignItems: 'stretch' }]}>
        {Array.from({ length: 12 }, (_, i) => {
          const suffix = String(i + 1).padStart(2, '0');
          return (
            <View key={suffix} style={{ width: '30%', flexGrow: 1 }}>
              <Button
                label={new Intl.DateTimeFormat('pt-BR', { month: 'short' })
                  .format(new Date(2026, i, 15))
                  .replace('.', '')}
                tone={`${year}-${suffix}` === month ? 'primary' : 'normal'}
                onPress={() => choose(`${year}-${suffix}`)}
              />
            </View>
          );
        })}
      </View>
      <Button label="Mês atual" onPress={() => choose(currentMonthIso())} />
    </Sheet>
  );
}
export function MonthField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const styles = useStyles(),
    [open, setOpen] = useState(false);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
        style={styles.select}
        onPress={() => {
          Keyboard.dismiss();
          setOpen(true);
        }}
      >
        <Text style={[styles.text, { flex: 1 }]}>
          {value.split('-').reverse().join('/')}
        </Text>
        <Icon name="calendar" />
      </Pressable>
      {open && (
        <MonthPicker
          month={value}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </View>
  );
}
