import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const channel = process.env.LIONPOCKET_BUILD_CHANNEL ?? 'normal';
if (!['normal', 'private-beta'].includes(channel)) throw new Error('Unknown LionPocket build channel.');
const beta = channel === 'private-beta';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: beta ? 'LionPocket Beta' : 'LionPocket',
    executableName: beta ? 'lionpocket-beta' : 'lionpocket',
    icon: 'assets/icon',
    // O plugin-vite empacota só a saída do build, então assets/ não entra no
    // asar. O ícone da janela precisa vir junto por fora dele.
    ...(beta ? { appBundleId: 'com.lionpocket.beta', appCopyright: 'LionPocket Beta' } : {}),
    extraResource: ['assets/icon.png'],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: beta ? 'lionpocket_beta' : 'lionpocket',
      setupExe: beta ? 'LionPocket-Beta-Instalador.exe' : 'LionPocket-Instalador.exe',
      ...(beta ? { exe: 'lionpocket-beta.exe', title: 'LionPocket Beta' } : {}),
      // Sem isto o instalador sai com o ícone padrão do Electron, mesmo com o
      // executável já usando o do app.
      setupIcon: 'assets/icon.ico',
    }),
    new MakerZIP({}, ['linux', 'win32']),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
