import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({ define: { LIONPOCKET_BUILD_CHANNEL: JSON.stringify(process.env.LIONPOCKET_BUILD_CHANNEL ?? 'normal'), LIONPOCKET_BETA_ENDPOINT: JSON.stringify(process.env.LIONPOCKET_BUILD_CHANNEL === 'private-beta' ? 'https://sync-beta.lionslab.dev' : '') } });
