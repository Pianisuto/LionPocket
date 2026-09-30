(async()=>{
  const {build}=await import('vite');
  await build({configFile:false,build:{outDir:'.vite/stage1',emptyOutDir:true,target:'node24',lib:{entry:'tools/sync-stage1/electron.ts',formats:['cjs'],fileName:()=> 'electron.cjs'},
    rollupOptions:{external:['electron','libsodium-wrappers-sumo',/^node:/]},minify:false}});
})().catch((error)=>{console.error(error);process.exitCode=1;});
