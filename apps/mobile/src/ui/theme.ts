// Sistema Juba: mesmos tokens do tema escuro em apps/desktop/src/index.css.
export const darkColors = {
  bg: '#140d13',
  deep: '#0d080d',
  surface: '#1d1420',
  surface2: '#271a29',
  surface3: '#322035',
  text: '#f9eff6',
  soft: '#d8bccd',
  muted: '#a0849a',
  line: '#34202f',
  lineStrong: '#482b41',
  primary: '#ff4d9d',
  primaryInk: '#ff8fc2',
  onPrimary: '#2f0518',
  primaryWash: '#ff4d9d21',
  positive: '#56d7ab',
  positiveWash: '#56d7ab24',
  negative: '#ff8a6b',
  negativeWash: '#ff8a6b24',
  alert: '#ff5d7e',
  alertWash: '#ff5d7e24',
  gold: '#ffc861',
};
export type Palette = typeof darkColors;
export const lightColors: Palette = {
  bg: '#fdf5fa', deep: '#f7e8f1', surface: '#ffffff', surface2: '#fdf1f7', surface3: '#fae2ef',
  text: '#2b1523', soft: '#6d4a5d', muted: '#92697f', line: '#f3dbe8', lineStrong: '#e8c3d9',
  primary: '#e11d74', primaryInk: '#c2185b', onPrimary: '#ffffff', primaryWash: '#e11d7417',
  positive: '#12a077', positiveWash: '#12a0771f', negative: '#e4622f', negativeWash: '#e4622f1f',
  alert: '#d81b52', alertWash: '#d81b521c', gold: '#d9880f',
};
export const fonts = {
  ui: 'Inter-Regular',
  medium: 'Inter-Medium',
  bold: 'Inter-SemiBold',
  display: 'BricolageGrotesque-Bold',
};
