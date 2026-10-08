import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { FreeNow } from '@lionpocket/core';
import { useStyles } from './components';
import { freeNowView } from './planningPresentation';

/** "Pode gastar hoje" with an expandable day-by-day balance, shared by the home balance card and Visão geral. */
export function FreeNowSummary({ freeNow }: { freeNow?: FreeNow | null }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const view = freeNowView(freeNow);
  if (!view) return null;
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.row}>
        <Text style={[styles.label, { flex: 1 }]}>{view.label}</Text>
        <Text accessibilityLabel={`${view.label} ${view.value}`} style={view.negative ? styles.danger : styles.heading}>
          {view.value}
        </Text>
      </View>
      <Text style={styles.muted}>{view.note}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
      >
        <Text style={styles.muted}>{open ? 'Ocultar dia a dia' : 'Ver dia a dia'}</Text>
      </Pressable>
      {open && (
        <>
          {view.timeline.map((row) => (
            <View key={row.key} style={styles.row}>
              <Text style={[styles.muted, { width: 48 }]}>{row.date}</Text>
              <View style={{ flex: 1 }}>
                <Text style={row.lowest ? styles.text : styles.muted}>{row.label}{row.lowest ? ' · mais apertado' : ''}</Text>
                {row.delta !== '' && <Text style={styles.muted}>{row.delta}</Text>}
              </View>
              <Text style={row.negative ? styles.danger : styles.text}>{row.balance}</Text>
            </View>
          ))}
          {view.lines.map((line) => (
            <View key={line.key} style={styles.row}>
              <Text style={[styles.muted, { flex: 1 }]}>{line.label}</Text>
              <Text style={line.negative ? styles.danger : styles.text}>{line.value}</Text>
            </View>
          ))}
          <View style={styles.row}>
            <Text style={[styles.label, { flex: 1 }]}>{view.label}</Text>
            <Text style={view.negative ? styles.danger : styles.heading}>{view.value}</Text>
          </View>
        </>
      )}
    </View>
  );
}
