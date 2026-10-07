import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { FreeNow } from '@lionpocket/core';
import { useStyles } from './components';
import { freeNowView } from './planningPresentation';

/** "Livre agora" with an expandable breakdown, shared by the home balance card and Visão geral. */
export function FreeNowSummary({ freeNow }: { freeNow?: FreeNow | null }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const view = freeNowView(freeNow);
  if (!view) return null;
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.row}>
        <Text style={[styles.label, { flex: 1 }]}>Livre agora</Text>
        <Text accessibilityLabel={`Livre agora ${view.value}`} style={view.negative ? styles.danger : styles.heading}>
          {view.value}
        </Text>
      </View>
      <Text style={styles.muted}>{view.horizon}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
      >
        <Text style={styles.muted}>{open ? 'Ocultar composição' : 'Ver composição'}</Text>
      </Pressable>
      {open &&
        view.lines.map((line) => (
          <View key={line.key} style={styles.row}>
            <Text style={[styles.muted, { flex: 1 }]}>{line.label}</Text>
            <Text style={line.negative ? styles.danger : styles.text}>{line.value}</Text>
          </View>
        ))}
    </View>
  );
}
