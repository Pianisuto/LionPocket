(async () => {
  const { build } = await import('vite');
  const reopen = process.argv.includes('--reopen');
  const transport = process.argv.includes('--transport');
  const smoke = process.argv.includes('--smoke');
  await build({
    configFile: false,
    build: {
      outDir: '.vite/sync-dev',
      emptyOutDir: !(smoke || transport || reopen),
      target: 'node24',
      lib: {
        entry: reopen
          ? 'tools/sync-dev/transport-reopen.ts'
          : transport
            ? 'tools/sync-dev/transport-electron.ts'
            : smoke
              ? 'tools/sync-dev/smoke-electron.ts'
              : 'tools/sync-dev/client.ts',
        formats: ['cjs'],
        fileName: () =>
          reopen
            ? 'reopen.cjs'
            : transport
              ? 'transport.cjs'
              : smoke
                ? 'smoke.cjs'
                : 'client.cjs',
      },
      rollupOptions: {
        external: [
          'pg',
          'jose',
          'electron',
          'libsodium-wrappers-sumo',
          /^node:/,
        ],
      },
      minify: false,
    },
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
