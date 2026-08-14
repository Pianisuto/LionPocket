import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { LionFace, LionMark, type LionAccessory, type LionMood } from '../src/ui/Lion';

const moods: LionMood[] = ['neutral', 'happy', 'proud', 'worried', 'alarmed', 'sleepy', 'roar', 'love', 'eating'];
const accessories: LionAccessory[] = ['bow', 'glasses', 'crown', 'party'];

const cell = 210;
const cols = 5;
const items = [
  { label: 'marca', svg: renderToStaticMarkup(<LionMark />) },
  ...moods.map((mood) => ({ label: mood, svg: renderToStaticMarkup(<LionFace mood={mood} />) })),
  { label: 'piscando', svg: renderToStaticMarkup(<LionFace blinking />) },
  ...accessories.map((accessory) => ({
    label: accessory,
    svg: renderToStaticMarkup(<LionFace accessory={accessory} />),
  })),
];

const rows = Math.ceil(items.length / cols);
const body = items
  .map((item, index) => {
    const x = (index % cols) * cell;
    const y = Math.floor(index / cols) * (cell + 34);
    const inner = item.svg.replace(
      '<svg ',
      `<svg x="${x + 16}" y="${y + 12}" width="${cell - 32}" height="${cell - 32}" `,
    );
    return `${inner}<text x="${x + cell / 2}" y="${y + cell + 10}" font-family="sans-serif" font-size="17" fill="#ffb8d8" text-anchor="middle">${item.label}</text>`;
  })
  .join('\n');

const width = cols * cell;
const height = rows * (cell + 34);
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#1b0f18"/>${body}</svg>`;

const main = async () => {
  const out = process.argv[2] ?? 'lion-sheet.png';
  await sharp(Buffer.from(sheet), { density: 200 }).png().toFile(out);
  fs.writeFileSync(`${out}.svg`, sheet);
  console.log(`Prévia em ${out}`);
};

main();
