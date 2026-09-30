import React, { useEffect, useRef, useState } from 'react';
import { Animated, Image, Pressable, Text, View } from 'react-native';
import {
  leoMessage,
  leoMood,
  type LeoMood,
  type LeoAccessory,
  type MonthlyOverview,
} from '@lionpocket/core';
import { useAppearance } from './Appearance';
import { Button, Sheet, useStyles } from './components';
import { leoAssets } from './leoAssets';

const accessories: LeoAccessory[] = [
  'none',
  'bow',
  'glasses',
  'crown',
  'party',
];
const accessoryNames = {
  none: 'juba solta',
  bow: 'laço rosa',
  glasses: 'óculos de contador',
  crown: 'coroa',
  party: 'chapéu de festa',
};
export function LeoScreen({
  overview,
  onClose,
  onGoals,
  onBackup,
  onExport,
}: {
  overview: MonthlyOverview | null;
  onClose: () => void;
  onGoals: () => void;
  onBackup: () => Promise<void>;
  onExport: () => Promise<boolean>;
}) {
  const styles = useStyles(),
    { preferences, update } = useAppearance();
  const [bubble, setBubble] = useState(
    'Me pergunta alguma coisa — ou só faz carinho.',
  );
  const [reaction, setReaction] = useState<LeoMood | null>(null);
  const [idle, setIdle] = useState(false),
    [blinking, setBlinking] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [glyph, setGlyph] = useState('');
  const pending = useRef(false);
  const mood = reaction ?? (idle ? 'sleepy' : leoMood(overview));
  const animation = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!reaction) return;
    const timer = setTimeout(() => {
      setReaction(null);
      setGlyph('');
    }, 3200);
    Animated.sequence([
      Animated.timing(animation, {
        toValue: 1.06,
        duration: 160,
        useNativeDriver: true,
      }),
      Animated.spring(animation, { toValue: 1, useNativeDriver: true }),
    ]).start();
    return () => {
      clearTimeout(timer);
      animation.stopAnimation();
    };
  }, [reaction, animation, bubble]);
  useEffect(() => {
    const timer = setTimeout(() => setIdle(true), 75_000);
    return () => clearTimeout(timer);
  }, [bubble, reaction]);
  useEffect(() => {
    let blinkTimer: ReturnType<typeof setTimeout>;
    const timer = setInterval(() => {
      setBlinking(true);
      blinkTimer = setTimeout(() => setBlinking(false), 150);
    }, 4800);
    return () => {
      clearInterval(timer);
      clearTimeout(blinkTimer);
    };
  }, []);
  const react = (next: LeoMood, text: string, particle = '') => {
    setIdle(false);
    setReaction(next);
    setBubble(text);
    setGlyph(particle);
  };
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Não foi possível concluir.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const pet = () =>
    void run(async () => {
      const pets = preferences.leoPets + 1;
      await update({ leoPets: pets });
      react(
        'love',
        pets === 1
          ? 'Ooown. Pode fazer de novo.'
          : pets % 25 === 0
            ? `${pets} carinhos! Sou oficialmente o leão mais mimado do Brasil.`
            : 'Rrrrr… ronronando em modo poupança.',
        '💗',
      );
    });
  return (
    <Sheet title="Léo, seu assistente" onClose={onClose} disabled={busy}>
      <View style={[styles.row, { justifyContent: 'center' }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Fazer carinho no Léo"
          disabled={busy}
          onPress={pet}
        >
          <Animated.View style={{ transform: [{ scale: animation }] }}>
            <Image
              source={
                leoAssets[
                  `${mood}-${preferences.leoAccessory}${blinking ? '-blink' : ''}`
                ]
              }
              style={{ width: 120, height: 120 }}
            />
          </Animated.View>
        </Pressable>
        <View style={{ flexShrink: 1, gap: 6 }}>
          <Text style={styles.heading}>Léo</Text>
          <Text style={styles.muted}>
            {preferences.leoPets} carinhos recebidos
          </Text>
          <Text style={styles.text}>{glyph}</Text>
        </View>
      </View>
      <Text accessibilityLiveRegion="polite" style={[styles.card, styles.text]}>
        {bubble}
      </Text>
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <Text style={styles.heading}>Me ajuda com</Text>
      <Button
        label="Como está o mês?"
        disabled={busy}
        onPress={() => {
          setIdle(false);
          setBubble(leoMessage(overview, 'month'));
        }}
      />
      <Button
        label="O que vence a seguir"
        icon="calendar"
        disabled={busy}
        onPress={() => {
          setIdle(false);
          setBubble(leoMessage(overview, 'upcoming'));
        }}
      />
      <Button
        label="Meus objetivos"
        icon="goal"
        disabled={busy}
        onPress={() => setBubble(leoMessage(overview, 'goals'))}
      />
      <Button label="Abrir objetivos" disabled={busy} onPress={onGoals} />
      <Button
        label="Guardar uma cópia"
        icon="data"
        disabled={busy}
        onPress={() =>
          void run(async () => {
            await onBackup();
            react('proud', 'Guardei tudo em segurança. Pode dormir tranquilo.');
          })
        }
      />
      <Button
        label="Exportar este mês"
        disabled={busy}
        onPress={() =>
          void run(async () => {
            if (await onExport())
              react(
                'happy',
                'Planilha pronta! Levei seus lançamentos para o arquivo.',
              );
            else setBubble('Exportação cancelada. Seus dados continuam aqui.');
          })
        }
      />
      <Button
        label={preferences.theme === 'dark' ? 'Acender a luz' : 'Apagar a luz'}
        icon={preferences.theme === 'dark' ? 'sun' : 'moon'}
        disabled={busy}
        onPress={() =>
          void run(() =>
            update({ theme: preferences.theme === 'dark' ? 'light' : 'dark' }),
          )
        }
      />
      <Text style={styles.heading}>Só por diversão</Text>
      <Button label="Fazer carinho" disabled={busy} onPress={pet} />
      <Button
        label="Rugir"
        disabled={busy}
        onPress={() =>
          react('roar', 'ROAAAR! Nenhuma taxa escondida passa por mim.', '💥')
        }
      />
      <Button
        label="Dar um petisco"
        disabled={busy}
        onPress={() =>
          react('eating', 'Nhac! Bem melhor que apertar o cinto.', '🍪')
        }
      />
      <Button
        label="Cochilar"
        disabled={busy}
        onPress={() => {
          react('sleepy', 'Zzz… me acorda se aparecer boleto.', '💤');
          setIdle(true);
        }}
      />
      <Button
        label="Trocar o visual"
        disabled={busy}
        onPress={() =>
          void run(async () => {
            const next =
              accessories[
                (accessories.indexOf(preferences.leoAccessory) + 1) %
                  accessories.length
              ];
            await update({ leoAccessory: next });
            react('proud', `Como ficou o ${accessoryNames[next]}?`, '✨');
          })
        }
      />
    </Sheet>
  );
}
