import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock,
  DatabaseBackup,
  FileSpreadsheet,
  Hand,
  Moon,
  PartyPopper,
  Sparkles,
  Target,
  Volume2,
  X,
} from 'lucide-react';
import type { Overview } from '../shared/types';
import { LionFace, type LionAccessory, type LionMood } from './Lion';
import { currency, formatDate } from './format';
import type { Theme } from './theme';

const ACCESSORY_KEY = 'lionpocket:leo-accessory';
const PETS_KEY = 'lionpocket:leo-pets';
const ACCESSORIES: LionAccessory[] = ['none', 'bow', 'glasses', 'crown', 'party'];
const ACCESSORY_NAMES: Record<LionAccessory, string> = {
  none: 'juba solta',
  bow: 'laço rosa',
  glasses: 'óculos de contador',
  crown: 'coroa',
  party: 'chapéu de festa',
};

/** Quanto tempo uma reação (rugido, carinho…) segura o humor antes de voltar. */
const REACTION_MS = 3200;
const IDLE_MS = 75_000;

type Particle = { id: number; glyph: string; left: number; delay: number };

const readNumber = (key: string) => {
  try {
    return Number(window.localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
};

const readAccessory = (): LionAccessory => {
  try {
    const stored = window.localStorage.getItem(ACCESSORY_KEY) as LionAccessory | null;
    if (stored && ACCESSORIES.includes(stored)) return stored;
  } catch {
    // Sem armazenamento o Léo simplesmente começa de juba solta.
  }
  return 'none';
};

const pick = <T,>(options: T[]) => options[Math.floor(Math.random() * options.length)];

/** O humor de base sai dos números reais do mês, não de um sorteio. */
const baseMood = (overview: Overview | null): LionMood => {
  if (!overview) return 'neutral';
  const { summary } = overview;
  if (summary.plannedIncome === 0 && summary.plannedExpenses === 0) return 'neutral';
  if (summary.projectedBalance < 0) return 'alarmed';
  if (summary.committedPercent > 0.85) return 'worried';
  if (summary.plannedExpenses > 0 && summary.paidExpenses >= summary.plannedExpenses) return 'proud';
  if (summary.projectedBalance > 0) return 'happy';
  return 'neutral';
};

const describeMonth = (overview: Overview | null) => {
  if (!overview) return 'Ainda estou abrindo as contas do mês…';
  const { summary, categoryBreakdown } = overview;
  if (summary.plannedIncome === 0 && summary.plannedExpenses === 0) {
    return 'Este mês está em branco. Que tal lançar a primeira entrada?';
  }
  const percent = Math.round(summary.committedPercent * 100);
  const top = categoryBreakdown[0];
  const topPart = top ? ` O maior peso é ${top.name}, com ${currency.format(top.amount)}.` : '';

  if (summary.projectedBalance < 0) {
    return `Cuidado: se tudo acontecer como está planejado, o mês fecha ${currency.format(Math.abs(summary.projectedBalance))} no vermelho.${topPart}`;
  }
  if (percent > 85) {
    return `${percent}% do que entra já está comprometido. Sobra pouco: ${currency.format(summary.projectedBalance)}.${topPart}`;
  }
  return `O mês fecha com ${currency.format(summary.projectedBalance)} de sobra e ${percent}% da renda comprometida.${topPart}`;
};

const describeUpcoming = (overview: Overview | null) => {
  const next = overview?.upcoming[0];
  if (!next) return 'Nenhuma conta em aberto neste mês. Aproveita o sossego.';
  const rest = (overview?.upcoming.length ?? 0) - 1;
  const tail = rest > 0 ? ` Depois dela vêm mais ${rest} no mês.` : ' E é a única do mês.';
  return `A próxima é ${next.description}: ${currency.format(next.plannedAmount)} em ${formatDate(next.dueDate)}.${tail}`;
};

const describeGoals = (overview: Overview | null) => {
  const goals = overview?.goals ?? [];
  if (goals.length === 0) return 'Você ainda não tem objetivos. Todo plano começa com um nome.';
  const closest = [...goals].sort((a, b) => b.progress - a.progress)[0];
  const missing = Math.max(0, closest.targetAmount - closest.savedAmount);
  return `“${closest.name}” está em ${Math.round(closest.progress * 100)}%. Faltam ${currency.format(missing)}.`;
};

export const Leo = ({
  overview,
  month,
  theme,
  onToggleTheme,
  onNavigate,
  notify,
}: {
  overview: Overview | null;
  month: string;
  theme: Theme;
  onToggleTheme: () => void;
  onNavigate: (view: string) => void;
  notify: (message: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [reaction, setReaction] = useState<LionMood | null>(null);
  const [bubble, setBubble] = useState('');
  const [blinking, setBlinking] = useState(false);
  const [idle, setIdle] = useState(false);
  const [particles, setParticles] = useState<Particle[]>([]);
  const [accessory, setAccessory] = useState<LionAccessory>(readAccessory);
  const [pets, setPets] = useState(() => readNumber(PETS_KEY));

  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const particleId = useRef(0);
  const timers = useRef<number[]>([]);

  /** setTimeout que se cancela sozinho ao desmontar e não acumula ids. */
  const later = useCallback((callback: () => void, delay: number) => {
    const id = window.setTimeout(() => {
      timers.current = timers.current.filter((item) => item !== id);
      callback();
    }, delay);
    timers.current.push(id);
  }, []);

  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);

  const mood: LionMood = reaction ?? (idle ? 'sleepy' : baseMood(overview));

  /** Uma reação: humor temporário + fala + partículas subindo. */
  const react = useCallback(
    (next: LionMood, message: string, glyph?: string, count = 6) => {
      setIdle(false);
      setReaction(next);
      setBubble(message);
      later(() => setReaction(null), REACTION_MS);
      later(() => setBubble((current) => (current === message ? '' : current)), 8000);
      if (!glyph) return;
      const batch = Array.from({ length: count }, () => ({
        id: (particleId.current += 1),
        glyph,
        left: 12 + Math.random() * 76,
        delay: Math.random() * 420,
      }));
      setParticles((current) => [...current, ...batch]);
      later(
        () => setParticles((current) => current.filter((item) => !batch.includes(item))),
        2400,
      );
    },
    [later],
  );

  /** Só fala, sem trocar o humor de base. */
  const say = useCallback(
    (message: string) => {
      setIdle(false);
      setBubble(message);
      later(() => setBubble((current) => (current === message ? '' : current)), 11_000);
    },
    [later],
  );

  // Piscadas espaçadas, para o rosto não ficar parado.
  useEffect(() => {
    let cancelled = false;
    let handle = 0;
    const schedule = () => {
      handle = window.setTimeout(() => {
        if (cancelled) return;
        setBlinking(true);
        window.setTimeout(() => !cancelled && setBlinking(false), 150);
        schedule();
      }, 3200 + Math.random() * 4200);
    };
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, []);

  // Sem interação por um bom tempo, o Léo cochila.
  useEffect(() => {
    const handle = window.setTimeout(() => setIdle(true), IDLE_MS);
    return () => window.clearTimeout(handle);
  }, [idle, open, reaction, bubble]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  const persist = (key: string, value: string) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // A brincadeira continua mesmo sem conseguir salvar.
    }
  };

  const petLeo = () => {
    const total = pets + 1;
    setPets(total);
    persist(PETS_KEY, String(total));
    const message =
      total === 1
        ? 'Ooown. Pode fazer de novo.'
        : total % 25 === 0
          ? `${total} carinhos! Sou oficialmente o leão mais mimado do Brasil.`
          : pick([
              'Rrrrr… ronronando em modo poupança.',
              'Isso vale mais que juros compostos.',
              'Cafuné aceito. Boleto, não.',
              'De novo, de novo!',
            ]);
    react('love', message, '💗', 8);
  };

  const usefulActions = [
    {
      icon: <Sparkles size={16} />,
      label: 'Como está o mês?',
      hint: 'Resumo com os números de agora',
      run: () => say(describeMonth(overview)),
    },
    {
      icon: <CalendarClock size={16} />,
      label: 'O que vence a seguir',
      hint: 'A próxima conta a pagar',
      run: () => say(describeUpcoming(overview)),
    },
    {
      icon: <Target size={16} />,
      label: 'Meus objetivos',
      hint: 'Quanto falta para o mais adiantado',
      run: () => {
        say(describeGoals(overview));
        onNavigate('goals');
      },
    },
    {
      icon: <DatabaseBackup size={16} />,
      label: 'Guardar uma cópia',
      hint: 'Backup do banco local',
      run: async () => {
        const path = await window.lionPocket.createBackup();
        if (path) {
          react('proud', 'Guardei tudo em segurança. Pode dormir tranquilo.');
          notify('Cópia de segurança criada.');
        }
      },
    },
    {
      icon: <FileSpreadsheet size={16} />,
      label: 'Exportar este mês',
      hint: 'Planilha CSV dos lançamentos',
      run: async () => {
        const path = await window.lionPocket.exportCsv(month);
        if (path) {
          react('happy', 'Planilha pronta! Levei seus lançamentos para o arquivo.');
          notify('Arquivo CSV criado.');
        }
      },
    },
    {
      icon: theme === 'dark' ? <Sparkles size={16} /> : <Moon size={16} />,
      label: theme === 'dark' ? 'Acender a luz' : 'Apagar a luz',
      hint: 'Alternar entre tema claro e escuro',
      run: onToggleTheme,
    },
  ];

  const funActions = [
    { icon: <Hand size={16} />, label: 'Fazer carinho', run: petLeo },
    {
      icon: <Volume2 size={16} />,
      label: 'Rugir',
      run: () =>
        react(
          'roar',
          pick([
            'ROAAAR! Nenhuma taxa escondida passa por mim.',
            'RRRROAR! Isso foi para assustar o cartão de crédito.',
            'Rugi tão alto que a fatura chegou mais barata.',
          ]),
          '💥',
          5,
        ),
    },
    {
      icon: <Sparkles size={16} />,
      label: 'Dar um petisco',
      run: () =>
        react(
          'eating',
          pick([
            'Nhac! Bem melhor que apertar o cinto.',
            'Petisco aceito. Já pode lançar como lazer.',
            'Hmm… posso ter um segundo?',
          ]),
          '🍪',
          5,
        ),
    },
    {
      icon: <Moon size={16} />,
      label: 'Cochilar',
      run: () => {
        react('sleepy', 'Zzz… me acorda se aparecer boleto.', '💤', 5);
        later(() => setIdle(true), REACTION_MS);
      },
    },
    {
      icon: <PartyPopper size={16} />,
      label: 'Trocar o visual',
      run: () => {
        const next = ACCESSORIES[(ACCESSORIES.indexOf(accessory) + 1) % ACCESSORIES.length];
        setAccessory(next);
        persist(ACCESSORY_KEY, next);
        react('proud', `Como ficou o ${ACCESSORY_NAMES[next]}?`, '✨', 6);
      },
    },
  ];

  // Um pontinho no botão quando os números merecem atenção.
  const alert = useMemo(() => {
    if (!overview) return false;
    return overview.summary.projectedBalance < 0 || overview.summary.committedPercent > 0.85;
  }, [overview]);

  return (
    <div className={`leo ${open ? 'leo--open' : ''}`}>
      {open && (
        <div className="leo__panel" ref={panelRef} role="dialog" aria-label="Léo, o assistente">
          <header className="leo__header">
            <button
              className="leo__portrait"
              onClick={petLeo}
              title="Fazer carinho no Léo"
              aria-label="Fazer carinho no Léo"
            >
              <LionFace mood={mood} blinking={blinking} accessory={accessory} />
              <span className="leo__particles" aria-hidden="true">
                {particles.map((particle) => (
                  <span
                    key={particle.id}
                    className="leo__particle"
                    style={{ left: `${particle.left}%`, animationDelay: `${particle.delay}ms` }}
                  >
                    {particle.glyph}
                  </span>
                ))}
              </span>
            </button>
            <div className="leo__identity">
              <strong>Léo</strong>
              <span>{pets > 0 ? `${pets} carinhos recebidos` : 'seu leão de estimação'}</span>
            </div>
            <button className="leo__close" onClick={() => setOpen(false)} aria-label="Fechar">
              <X size={16} />
            </button>
          </header>

          <p className={`leo__bubble ${bubble ? '' : 'leo__bubble--idle'}`} aria-live="polite">
            {bubble || 'Me pergunta alguma coisa — ou só faz carinho.'}
          </p>

          <div className="leo__section">
            <span className="leo__label">Me ajuda com</span>
            <div className="leo__actions">
              {usefulActions.map((action) => (
                <button key={action.label} className="leo__action" onClick={action.run} title={action.hint}>
                  {action.icon}
                  <span>{action.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="leo__section">
            <span className="leo__label">Só por diversão</span>
            <div className="leo__actions leo__actions--fun">
              {funActions.map((action) => (
                <button key={action.label} className="leo__action leo__action--fun" onClick={action.run}>
                  {action.icon}
                  <span>{action.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <button
        ref={buttonRef}
        className={`leo__button ${alert ? 'leo__button--alert' : ''}`}
        onClick={() => {
          setIdle(false);
          setOpen((value) => !value);
        }}
        aria-expanded={open}
        aria-label={open ? 'Fechar o Léo' : 'Falar com o Léo'}
      >
        <LionFace mood={mood} blinking={blinking} accessory={accessory} detail={false} />
      </button>
    </div>
  );
};
