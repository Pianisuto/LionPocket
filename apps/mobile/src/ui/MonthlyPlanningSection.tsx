import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { addMonths, type MonthlyPlanning } from '@lionpocket/core';
import { getMonthlyPlanning, saveMonthlyPlanning } from '../db/transactions';
import { Button, IconButton, money, useStyles } from './components';
import { SafetyMarginEditor } from './PlanningEditors';

export function MonthlyPlanningSection({ month, onMonth, onChanged }: {
  month: string; onMonth: (month: string) => void; onChanged: () => Promise<void>;
}) {
  const styles = useStyles();
  const [planning, setPlanning] = useState<MonthlyPlanning | null>(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    getMonthlyPlanning(month).then(value => { if (active) setPlanning(value); })
      .catch(() => { if (active) setError('Não foi possível carregar o planejamento.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [month, reload]);
  const cents = planning?.safetyMarginCents ?? 0;
  return <View style={styles.card}>
    <Text style={styles.label}>Planejamento do mês</Text>
    <View style={styles.row}>
      <IconButton icon="left" label="Mês anterior" disabled={month === '1000-01'} onPress={() => onMonth(addMonths(`${month}-01`, -1).slice(0, 7))} />
      <Text style={[styles.text, { flex: 1, textAlign: 'center' }]}>{new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(new Date(`${month}-15T12:00:00`))}</Text>
      <IconButton icon="right" label="Próximo mês" disabled={month === '9999-12'} onPress={() => onMonth(addMonths(`${month}-01`, 1).slice(0, 7))} />
    </View>
    <Text style={styles.heading}>Margem de segurança</Text>
    <Text style={styles.muted}>Para imprevistos, sem criar uma despesa.</Text>
    {!loading && cents > 0 && <Text style={styles.heading}>{money(cents / 100)}</Text>}
    {error ? <><Text accessibilityRole="alert" style={styles.error}>{error}</Text><Button label="Tentar novamente" onPress={() => setReload(value => value + 1)} /></> : null}
    <Button label={cents > 0 ? 'Editar margem' : 'Definir margem de segurança'} disabled={loading || !!error} onPress={() => setEditing(true)} />
    {editing && <SafetyMarginEditor month={month} cents={cents} onClose={() => setEditing(false)} onSave={async value => {
      await saveMonthlyPlanning({ month, safetyMarginCents: value });
      setPlanning({ month, safetyMarginCents: value });
      setEditing(false);
      await onChanged();
    }} />}
  </View>;
}
