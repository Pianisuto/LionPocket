import { pairingQr } from '@lionpocket/sync-local';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Image,
  NativeModules,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { TextInputProps } from 'react-native';
import { useAppearance } from '../../Appearance';
import { Icon, type IconName } from '../../Icon';
import { fonts, type Palette } from '../../theme';

/*
 * Building blocks of the sync screens. They use only the basic React Native
 * primitives, so the sync flows stay testable without a device.
 */

const createSyncStyles = (colors: Palette) =>
  StyleSheet.create({
    panel: { gap: 14 },
    card: {
      gap: 14,
      padding: 18,
      borderWidth: 1,
      borderRadius: 20,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    cardDanger: { borderColor: colors.alertWash },
    cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    cardIcon: {
      width: 36,
      height: 36,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primaryWash,
    },
    cardIconDanger: { backgroundColor: colors.alertWash },
    cardTitle: {
      color: colors.text,
      fontSize: 16,
      fontFamily: fonts.display,
      letterSpacing: -0.2,
    },
    grow: { flex: 1, minWidth: 0, gap: 4 },
    text: {
      color: colors.text,
      fontSize: 14,
      fontFamily: fonts.ui,
      lineHeight: 21,
    },
    muted: {
      color: colors.muted,
      fontSize: 12.5,
      fontFamily: fonts.ui,
      lineHeight: 19,
    },
    strong: { color: colors.text, fontSize: 14, fontFamily: fonts.bold },
    label: { color: colors.soft, fontSize: 13, fontFamily: fonts.medium },
    field: { gap: 8 },
    input: {
      color: colors.text,
      backgroundColor: colors.bg,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: 14,
      padding: 14,
      fontSize: 15,
      fontFamily: fonts.ui,
      minHeight: 50,
    },
    actions: { gap: 10 },
    choice: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 12,
      padding: 14,
      minHeight: 48,
      borderWidth: 1,
      borderRadius: 16,
    },
    indicator: {
      width: 20,
      height: 20,
      flexShrink: 0,
      marginTop: 1,
      borderWidth: 1,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dot: { width: 10, height: 10, borderRadius: 5 },
    notice: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      padding: 14,
      borderRadius: 16,
      borderWidth: 1,
    },
    code: {
      padding: 14,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.primaryWash,
      backgroundColor: colors.primaryWash,
      color: colors.primaryInk,
      fontSize: 15,
      fontFamily: fonts.bold,
      letterSpacing: 0.6,
    },
    disclosure: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      minHeight: 56,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderWidth: 1,
      borderRadius: 18,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    disclosureBody: { gap: 14, paddingTop: 4 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 10,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    qr: {
      width: 240,
      height: 240,
      alignSelf: 'center',
      borderRadius: 16,
      backgroundColor: '#fff',
    },
    disabled: { opacity: 0.45 },
  });

export function useSyncStyles() {
  const { colors } = useAppearance();
  return useMemo(() => createSyncStyles(colors), [colors]);
}

export function SyncCard({
  icon,
  title,
  description,
  tone,
  children,
}: {
  icon: IconName;
  title: string;
  description?: string;
  tone?: 'danger';
  children?: React.ReactNode;
}) {
  const styles = useSyncStyles();
  const { colors } = useAppearance();
  return (
    <View style={[styles.card, tone === 'danger' && styles.cardDanger]}>
      <View style={styles.cardHeader}>
        <View style={[styles.cardIcon, tone === 'danger' && styles.cardIconDanger]}>
          <Icon
            name={icon}
            size={18}
            color={tone === 'danger' ? colors.alert : colors.primaryInk}
          />
        </View>
        <View style={styles.grow}>
          <Text accessibilityRole="header" style={styles.cardTitle}>
            {title}
          </Text>
          {description && <Text style={styles.muted}>{description}</Text>}
        </View>
      </View>
      {children}
    </View>
  );
}

/** Collapsed group for rare or technical options. */
export function SyncDisclosure({
  icon,
  title,
  description,
  open,
  onToggle,
  children,
}: {
  icon: IconName;
  title: string;
  description?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const styles = useSyncStyles();
  const { colors } = useAppearance();
  return (
    <View style={styles.panel}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={({ pressed }) => [styles.disclosure, pressed && { opacity: 0.72 }]}
      >
        <Icon name={icon} color={colors.primaryInk} />
        <View style={styles.grow}>
          <Text style={styles.strong}>{title}</Text>
          {description && <Text style={styles.muted}>{description}</Text>}
        </View>
        <Icon name={open ? 'up' : 'down'} size={18} />
      </Pressable>
      {open && <View style={styles.disclosureBody}>{children}</View>}
    </View>
  );
}

/** Text field whose visible label is also its accessible name. */
export function SyncField({
  label,
  hint,
  inputRef,
  ...input
}: Omit<TextInputProps, 'accessibilityLabel' | 'style'> & {
  label: string;
  hint?: string;
  inputRef?: React.Ref<React.ComponentRef<typeof TextInput>>;
}) {
  const styles = useSyncStyles();
  const { colors } = useAppearance();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        ref={inputRef}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={colors.muted}
        selectionColor={colors.primary}
        style={styles.input}
        {...input}
      />
      {hint && <Text style={styles.muted}>{hint}</Text>}
    </View>
  );
}

export function SyncChoice({
  label,
  description,
  checked,
  disabled,
  onPress,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const styles = useSyncStyles();
  const { colors } = useAppearance();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        {
          borderColor: checked ? colors.primary : colors.line,
          backgroundColor: checked ? colors.primaryWash : colors.surface2,
        },
        disabled && styles.disabled,
        pressed && { opacity: 0.72 },
      ]}
    >
      <View
        style={[
          styles.indicator,
          { borderColor: checked ? colors.primary : colors.lineStrong },
        ]}
      >
        {checked && (
          <View style={[styles.dot, { backgroundColor: colors.primary }]} />
        )}
      </View>
      <View style={styles.grow}>
        <Text style={[styles.strong, checked && { color: colors.primaryInk }]}>
          {label}
        </Text>
        <Text style={styles.muted}>{description}</Text>
      </View>
    </Pressable>
  );
}

export function SyncCheck({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const styles = useSyncStyles();
  const { colors } = useAppearance();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={({ pressed }) => [
        styles.choice,
        { backgroundColor: colors.surface2, borderColor: colors.line },
        disabled && styles.disabled,
        pressed && { opacity: 0.72 },
      ]}
    >
      <View
        style={[
          styles.indicator,
          {
            borderRadius: 5,
            borderColor: checked ? colors.primary : colors.lineStrong,
            backgroundColor: checked ? colors.primary : 'transparent',
          },
        ]}
      >
        {checked && <Icon name="check" size={14} color={colors.onPrimary} />}
      </View>
      <Text style={[styles.text, styles.grow]}>{label}</Text>
    </Pressable>
  );
}

export function SyncNotice({
  tone,
  title,
  children,
}: {
  tone: 'warning' | 'error';
  title?: string;
  children: React.ReactNode;
}) {
  const styles = useSyncStyles();
  const { colors } = useAppearance();
  const color = tone === 'error' ? colors.alert : colors.gold;
  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.notice,
        {
          borderColor: tone === 'error' ? colors.alertWash : `${colors.gold}40`,
          backgroundColor: tone === 'error' ? colors.alertWash : `${colors.gold}14`,
        },
      ]}
    >
      <View style={styles.grow}>
        {title && <Text style={[styles.strong, { color }]}>{title}</Text>}
        <Text style={[styles.text, { color }]}>{children}</Text>
      </View>
    </View>
  );
}

export function PairingQR({ link }: { link: string }) {
  const styles = useSyncStyles();
  const [uri, setUri] = useState('');
  useEffect(() => {
    let cancelled = false;
    const rows = pairingQr(link).map((row) =>
      row.map((dark) => (dark ? '1' : '0')).join(''),
    );
    void NativeModules.LionPocketPairing.renderQr(rows)
      .then((value: string) => {
        if (!cancelled) setUri(value);
      })
      .catch(() => {
        /* Sharing the same local invitation stays available. */
      });
    return () => {
      cancelled = true;
    };
  }, [link]);
  return uri ? (
    <Image
      accessibilityLabel="QR Code para conectar outro aparelho"
      source={{ uri }}
      style={styles.qr}
    />
  ) : (
    <Text style={styles.muted}>Preparando QR Code…</Text>
  );
}
