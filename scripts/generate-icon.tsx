/**
 * Gera os ícones do aplicativo a partir do mesmo desenho do mascote.
 *
 * O Léo é desenhado uma vez só, em src/ui/Lion.tsx. Este script transforma
 * aquele componente em assets/icon.svg, assets/icon.png e assets/icon.ico,
 * então o ícone nunca fica diferente do mascote que aparece dentro do app.
 *
 *   npm run icons
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { LionMark } from '../src/ui/Lion';

const assets = path.join(process.cwd(), 'assets');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const svg = `${renderToStaticMarkup(<LionMark />).replace(
  '<svg ',
  '<svg xmlns="http://www.w3.org/2000/svg" ',
)}\n`;

const raster = (size: number) =>
  sharp(Buffer.from(svg), { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();

const main = async () => {
  await fs.mkdir(assets, { recursive: true });
  await fs.writeFile(path.join(assets, 'icon.svg'), svg, 'utf8');
  await fs.writeFile(path.join(assets, 'icon.png'), await raster(512));

  const layers = await Promise.all(ICO_SIZES.map(raster));
  await fs.writeFile(path.join(assets, 'icon.ico'), await pngToIco(layers));

  console.log(`Ícones gerados em ${assets} (svg, png 512, ico ${ICO_SIZES.join('/')}).`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
