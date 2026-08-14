import { useId } from 'react';

/**
 * Léo, o leão do LionPocket.
 *
 * Um único desenho serve para tudo: o ícone do aplicativo, a marca da barra de
 * título e o mascote grande e expressivo. O humor troca olhos, sobrancelhas e
 * boca; o resto do rosto continua o mesmo.
 *
 * O desenho vive no quadro 512×512 com o rosto centrado em (256, 262).
 */
export type LionMood =
  | 'neutral'
  | 'happy'
  | 'proud'
  | 'worried'
  | 'alarmed'
  | 'sleepy'
  | 'roar'
  | 'love'
  | 'eating';

export type LionAccessory = 'none' | 'bow' | 'glasses' | 'crown' | 'party';

const INK = '#3d1026';

/** Tufos da juba: círculos iguais em anel, que se fundem em uma silhueta só. */
const tufts = (count: number, radius: number, size: number) =>
  Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
    return (
      <circle
        key={index}
        cx={256 + Math.cos(angle) * radius}
        cy={262 + Math.sin(angle) * radius}
        r={size}
      />
    );
  });

const Eyes = ({ mood, blinking }: { mood: LionMood; blinking: boolean }) => {
  const left = 216;
  const right = 296;
  const y = 246;

  if (blinking || mood === 'sleepy' || mood === 'eating') {
    const curve = mood === 'sleepy' ? 14 : -15;
    return (
      <g fill="none" stroke={INK} strokeWidth={9} strokeLinecap="round">
        <path d={`M${left - 17} ${y} q17 ${curve} 34 0`} />
        <path d={`M${right - 17} ${y} q17 ${curve} 34 0`} />
      </g>
    );
  }

  if (mood === 'happy' || mood === 'proud') {
    return (
      <g fill="none" stroke={INK} strokeWidth={10} strokeLinecap="round">
        <path d={`M${left - 18} ${y + 6} q18 -22 36 0`} />
        <path d={`M${right - 18} ${y + 6} q18 -22 36 0`} />
      </g>
    );
  }

  if (mood === 'love') {
    const heart = (cx: number) =>
      `M${cx} ${y + 16} c-16 -12 -22 -20 -22 -28 a11 11 0 0 1 22 -6 a11 11 0 0 1 22 6 c0 8 -6 16 -22 28 Z`;
    return (
      <g fill="#e6376f">
        <path d={heart(left)} />
        <path d={heart(right)} />
      </g>
    );
  }

  // Olhos abertos. O tamanho muda conforme a tensão do humor.
  const ry = mood === 'alarmed' ? 22 : mood === 'roar' ? 14 : 19;
  const rx = mood === 'roar' ? 15 : 16;
  return (
    <g>
      <ellipse cx={left} cy={y} rx={rx} ry={ry} fill={INK} />
      <ellipse cx={right} cy={y} rx={rx} ry={ry} fill={INK} />
      <circle cx={left + 6} cy={y - 7} r={5.5} fill="#fff" />
      <circle cx={right + 6} cy={y - 7} r={5.5} fill="#fff" />
    </g>
  );
};

const Brows = ({ mood }: { mood: LionMood }) => {
  // Pontas internas erguidas viram preocupação; abaixadas viram determinação.
  const shape =
    mood === 'worried' || mood === 'alarmed'
      ? ['M196 208 q18 -7 34 3', 'M316 208 q-18 -7 -34 3']
      : mood === 'roar' || mood === 'proud'
        ? ['M196 202 q18 4 34 13', 'M316 202 q-18 4 -34 13']
        : null;
  if (!shape) return null;
  return (
    <g fill="none" stroke={INK} strokeWidth={9} strokeLinecap="round" opacity={0.9}>
      <path d={shape[0]} />
      <path d={shape[1]} />
    </g>
  );
};

const Mouth = ({ mood }: { mood: LionMood }) => {
  if (mood === 'roar') {
    return (
      <g>
        <path d="M232 306 q24 -8 48 0 q-2 44 -24 44 t-24 -44 Z" fill="#8e1338" />
        <path d="M236 308 q20 -6 40 0 l-5 9 q-15 -4 -30 0 Z" fill="#fff" />
        <path d="M245 340 q11 8 22 0 q-7 12 -22 0 Z" fill="#ff6f9d" />
      </g>
    );
  }
  if (mood === 'eating') {
    return <path d="M234 304 q22 28 44 0 q-8 24 -22 24 t-22 -24 Z" fill="#8e1338" />;
  }
  if (mood === 'alarmed') {
    return <ellipse cx={256} cy={320} rx={14} ry={17} fill="#8e1338" />;
  }
  if (mood === 'worried') {
    return (
      <path d="M238 324 q18 -12 36 0" fill="none" stroke={INK} strokeWidth={8} strokeLinecap="round" />
    );
  }
  // Boca padrão em "w", mais aberta nos humores alegres.
  const drop = mood === 'happy' || mood === 'proud' || mood === 'love' ? 17 : 11;
  return (
    <path
      d={`M256 300 v10 M256 310 q-14 ${drop} -27 2 M256 310 q14 ${drop} 27 2`}
      fill="none"
      stroke={INK}
      strokeWidth={8}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
};

const Accessory = ({ accessory }: { accessory: LionAccessory }) => {
  if (accessory === 'bow') {
    return (
      <g transform="translate(344 146) rotate(16)">
        <path d="M0 0 -46 -28 -46 28 Z" fill="#ff9ecb" />
        <path d="M0 0 46 -28 46 28 Z" fill="#ff9ecb" />
        <circle r="14" fill="#ffd0e6" />
      </g>
    );
  }
  if (accessory === 'glasses') {
    return (
      <g fill="none" stroke="#2f0c1d" strokeWidth={8} strokeLinecap="round">
        <circle cx="216" cy="246" r="37" fill="#bfe9ff" fillOpacity="0.3" />
        <circle cx="296" cy="246" r="37" fill="#bfe9ff" fillOpacity="0.3" />
        <path d="M253 244 h6" />
        <path d="M179 238 L150 227" />
        <path d="M333 238 L362 227" />
      </g>
    );
  }
  if (accessory === 'crown') {
    return (
      <g transform="translate(256 128)">
        <path d="M-54 26 -60 -28 -27 -3 0 -36 27 -3 60 -28 54 26 Z" fill="#ffc861" />
        <path d="M-54 26 h108 v11 h-108 Z" fill="#eea62c" />
        <circle cx="0" cy="7" r="8" fill="#e6376f" />
      </g>
    );
  }
  if (accessory === 'party') {
    return (
      <g transform="translate(338 116) rotate(24)">
        <path d="M0 0 -32 88 32 88 Z" fill="#ff5c9e" />
        <path d="M-32 88 32 88 27 73 -27 73 Z" fill="#ffc861" />
        <circle cx="0" cy="-11" r="14" fill="#ffd0e6" />
      </g>
    );
  }
  return null;
};

/**
 * O desenho em si, sem o elemento <svg> em volta, para poder ser reaproveitado
 * dentro de outras composições (como a marca fechada).
 */
export const LionArt = ({
  id,
  mood = 'neutral',
  blinking = false,
  accessory = 'none',
  detail = true,
}: {
  id: string;
  mood?: LionMood;
  blinking?: boolean;
  accessory?: LionAccessory;
  detail?: boolean;
}) => (
  <>
    <defs>
      <linearGradient id={`${id}-mane`} x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0" stopColor="#ff7cb7" />
        <stop offset="1" stopColor="#d21e6f" />
      </linearGradient>
      <linearGradient id={`${id}-fringe`} x1="0" y1="0" x2="0.3" y2="1">
        <stop offset="0" stopColor="#c81a67" />
        <stop offset="1" stopColor="#8b0f48" />
      </linearGradient>
      <linearGradient id={`${id}-face`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#fff1e0" />
        <stop offset="1" stopColor="#ffd9b8" />
      </linearGradient>
    </defs>

    {/* Franja escura da juba, atrás de tudo. */}
    <g fill={`url(#${id}-fringe)`}>{tufts(13, 124, 47)}</g>
    {/* Corpo da juba. */}
    <g fill={`url(#${id}-mane)`}>
      {tufts(13, 108, 40)}
      <circle cx="256" cy="262" r="124" />
    </g>

    {/* Orelhas: encostam na juba e ficam atrás do rosto. */}
    <g>
      <circle cx="178" cy="198" r="34" fill="#ffdcbe" />
      <circle cx="334" cy="198" r="34" fill="#ffdcbe" />
      <circle cx="178" cy="200" r="19" fill="#ff8ebc" />
      <circle cx="334" cy="200" r="19" fill="#ff8ebc" />
    </g>

    <circle cx="256" cy="262" r="99" fill={`url(#${id}-face)`} />

    {detail && (
      <g fill="#ff9dc2" opacity="0.5">
        <ellipse cx="184" cy="294" rx="21" ry="14" />
        <ellipse cx="328" cy="294" rx="21" ry="14" />
      </g>
    )}

    <Brows mood={mood} />
    <Eyes mood={mood} blinking={blinking} />

    {/* Focinho: dois lóbulos claros e um nariz de coração. */}
    <g>
      <ellipse cx="235" cy="300" rx="30" ry="24" fill="#fff7ec" />
      <ellipse cx="277" cy="300" rx="30" ry="24" fill="#fff7ec" />
      <path
        d="M256 296 c-13 -10 -18 -16 -18 -23 a9.5 9.5 0 0 1 18 -5 a9.5 9.5 0 0 1 18 5 c0 7 -5 13 -18 23 Z"
        fill="#e6376f"
      />
    </g>

    <Mouth mood={mood} />

    {detail && (
      <g stroke={INK} strokeWidth={5} strokeLinecap="round" opacity="0.28" fill="none">
        <path d="M200 291 L170 283 M200 304 L170 311" />
        <path d="M312 291 L342 283 M312 304 L342 311" />
      </g>
    )}

    <Accessory accessory={accessory} />
  </>
);

export const LionFace = ({
  mood = 'neutral',
  blinking = false,
  accessory = 'none',
  detail = true,
  className,
}: {
  mood?: LionMood;
  blinking?: boolean;
  accessory?: LionAccessory;
  /** Desliga bigodes e blush — o desenho fica limpo em tamanhos pequenos. */
  detail?: boolean;
  className?: string;
}) => {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="60 70 392 392" className={className} role="img" aria-hidden="true">
      <LionArt id={id} mood={mood} blinking={blinking} accessory={accessory} detail={detail} />
    </svg>
  );
};

/** A marca fechada: Léo dentro do quadrado arredondado ameixa. */
export const LionMark = ({ className }: { className?: string }) => {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 512 512" className={className} role="img" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-badge`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#43163a" />
          <stop offset="1" stopColor="#1b0b18" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="132" fill={`url(#${id}-badge)`} />
      {/* O desenho ocupa ~336px do quadro; ampliar para preencher o losango. */}
      <g transform="translate(256 264) scale(1.2) translate(-256 -262)">
        <LionArt id={`${id}-art`} detail={false} />
      </g>
    </svg>
  );
};
