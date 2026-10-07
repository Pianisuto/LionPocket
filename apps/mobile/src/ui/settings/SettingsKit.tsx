import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppearance } from '../Appearance';
import { IconButton } from '../components';
import { Icon, type IconName } from '../Icon';
import { fonts, type Palette } from '../theme';

const createSettingsStyles = (colors: Palette) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    headerTitle: {
      color: colors.text,
      fontSize: 24,
      fontFamily: fonts.display,
      letterSpacing: -0.5,
    },
    page: { padding: 20, paddingBottom: 40, gap: 22 },
    lead: {
      color: colors.muted,
      fontSize: 13,
      fontFamily: fonts.ui,
      lineHeight: 19,
    },
    group: { gap: 10 },
    groupHeader: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      gap: 12,
      paddingHorizontal: 4,
    },
    groupTitle: {
      flexShrink: 1,
      color: colors.text,
      fontSize: 17,
      fontFamily: fonts.display,
      letterSpacing: -0.2,
    },
    count: { color: colors.muted, fontSize: 13, fontFamily: fonts.medium },
    groupBody: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 20,
      backgroundColor: colors.surface,
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      minHeight: 60,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    rowDivider: { borderTopWidth: 1, borderTopColor: colors.line },
    rowIcon: {
      width: 38,
      height: 38,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primaryWash,
    },
    rowText: { flex: 1, minWidth: 0, gap: 3 },
    rowTitle: { color: colors.text, fontSize: 15, fontFamily: fonts.bold },
    rowDescription: {
      color: colors.muted,
      fontSize: 12.5,
      fontFamily: fonts.ui,
      lineHeight: 18,
    },
    note: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 12,
      padding: 16,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 18,
    },
    notice: {
      color: colors.positive,
      fontFamily: fonts.medium,
      fontSize: 13.5,
      paddingHorizontal: 4,
    },
  });

export function useSettingsStyles() {
  const { colors } = useAppearance();
  return useMemo(() => createSettingsStyles(colors), [colors]);
}

/** Header of a settings page: back to the list, or close settings. */
export function SettingsHeader({
  title,
  onBack,
  onClose,
  disabled,
}: {
  title: string;
  onBack?: () => void;
  onClose: () => void;
  disabled: boolean;
}) {
  const styles = useSettingsStyles();
  return (
    <View style={styles.header}>
      {onBack && (
        <IconButton label="Voltar" icon="left" disabled={disabled} onPress={onBack} />
      )}
      <Text accessibilityRole="header" style={[styles.headerTitle, { flex: 1 }]}>
        {title}
      </Text>
      <IconButton label="Fechar" icon="close" disabled={disabled} onPress={onClose} />
    </View>
  );
}

/** Titled list of rows sharing one surface. */
export function SettingsGroup({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const styles = useSettingsStyles();
  return (
    <View style={styles.group}>
      <View style={styles.groupHeader}>
        <Text accessibilityRole="header" style={styles.groupTitle}>
          {title}
          {count !== undefined && <Text style={styles.count}>  {count}</Text>}
        </Text>
        {action}
      </View>
      <View style={styles.groupBody}>{children}</View>
    </View>
  );
}

export function SettingsRow({
  icon,
  iconColor,
  leading,
  title,
  description,
  trailing,
  onPress,
  accessibilityLabel,
  first = false,
  disabled = false,
}: {
  icon?: IconName;
  iconColor?: string;
  /** Replaces the icon, e.g. a category colour. */
  leading?: React.ReactNode;
  title: string;
  description?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  /** The first row of a group has no divider above it. */
  first?: boolean;
  disabled?: boolean;
}) {
  const styles = useSettingsStyles();
  const { colors } = useAppearance();
  const content = (
    <>
      {leading ??
        (icon && (
          <View style={styles.rowIcon}>
            <Icon name={icon} size={19} color={iconColor ?? colors.primaryInk} />
          </View>
        ))}
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {title}
        </Text>
        {description && <Text style={styles.rowDescription}>{description}</Text>}
      </View>
      {trailing ?? (onPress && <Icon name="right" size={18} color={colors.muted} />)}
    </>
  );
  if (!onPress)
    return <View style={[styles.row, !first && styles.rowDivider]}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={description}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        !first && styles.rowDivider,
        pressed && { backgroundColor: colors.surface2 },
        disabled && { opacity: 0.45 },
      ]}
    >
      {content}
    </Pressable>
  );
}

/** Context for a page, such as where data is kept. */
export function SettingsNote({
  icon,
  title,
  children,
}: {
  icon: IconName;
  title: string;
  children: React.ReactNode;
}) {
  const styles = useSettingsStyles();
  const { colors } = useAppearance();
  return (
    <View style={styles.note}>
      <Icon name={icon} size={18} color={colors.positive} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowDescription}>{children}</Text>
      </View>
    </View>
  );
}
