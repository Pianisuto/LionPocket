#!/usr/bin/env node
const {spawn,spawnSync,execFileSync} = require('node:child_process');
const {existsSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,renameSync,openSync,closeSync,unlinkSync,copyFileSync} = require('node:fs');
const {resolve,join,dirname,basename} = require('node:path');
const {homedir,tmpdir} = require('node:os');
const {randomUUID} = require('node:crypto');
const net = require('node:net');
const {git,sourceFingerprint,requireIndexMatchesWorktree,requireHeadMatchesIndex,requirePushTargetsHead,receiptMatches} = require('./state.cjs');
const {createBudget} = require('./budget.cjs');
const root = resolve(__dirname,'../..');
const args = process.argv.slice(2);
const hook = args.find(arg=>arg.startsWith('--hook='))?.slice(7);
const full = args.includes('--full');
const androidOnly = args.includes('--android-only');
const plan = args.includes('--plan');
const steps = ['Versões e metadados','Testes gerais','Typecheck','Lint','Integração PostgreSQL/Keycloak','Self-hosted completo','Linux normal/beta: pacote, SQLite e protocolo instalado em containers','Android debug/normal/beta, assinatura, atualização SQLite, deep link e cofre nativo em emulador descartável'];
if (args.some(arg=>!['--full','--android-only','--plan','--hook=pre-commit','--hook=pre-push'].includes(arg)) || args.length>1) throw new Error('Argumentos de validação inválidos.');
if(plan) { console.log('validate:local / hooks: checks rápidos (deadline 55s), sem Docker/emulador/empacotamento.\nvalidate:full (manual):\n'+steps.join('\n')+'\nPendente neste host Linux: instalador/protocolo/DPAPI Windows (requer Windows descartável).\nNenhuma chamada ao GitHub Actions.'); process.exit(0); }
let log, lock, budget, interrupted=false;
const children = new Set();
const containers = new Set();
const abort = () => { interrupted=true; for(const child of children) { if(process.platform==='win32') child.kill('SIGINT'); else try{process.kill(-child.pid,'SIGINT');}catch{} } };
process.on('SIGINT',abort); process.on('SIGTERM',abort);
function capture(file,params,options={}) {
  const result = spawnSync(file,params,{cwd:root,encoding:'utf8',...options});
  if(result.status!==0) throw new Error('Pré-requisito falhou: '+file+' '+params[0]);
  return (result.stdout+'\n'+result.stderr).trim();
}
function run(label,file,params,options={}) {
  if(interrupted&&!options.cleanup) return Promise.reject(new Error('Validação interrompida.'));
  console.log('\n[local] '+label);
  return new Promise((resolveRun,reject) => {
    const current = spawn(file,params,{cwd:root,env:process.env,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],...options});
    children.add(current);
    for(const [stream,target] of [[current.stdout,process.stdout],[current.stderr,process.stderr]]) stream.on('data',data=>{target.write(data); if(log!==undefined) require('node:fs').writeSync(log,data);});
    current.stdin.end(options.input || '');
    current.on('error',error=>{children.delete(current);reject(error);});
    current.on('close',(code,signal)=>{ children.delete(current); code===0&&(!interrupted||options.cleanup) ? resolveRun() : reject(new Error(label+' falhou ('+(signal||code)+'). Nenhum recibo foi emitido.')); });
  });
}
const npmCli = process.env.npm_execpath || [resolve(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'),resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js')].find(existsSync);
function npm(label,script,options={}) { if(!npmCli) throw new Error('Execute com npm run validate:local.'); return run(label,process.execPath,[npmCli,'run',script],options); }
const node = (label,file,params=[],options={}) => run(label,process.execPath,[file,...params],options);
function configuration() {
  if(Number(process.versions.node.split('.')[0])<24) throw new Error('Node 24 ou superior é necessário.');
  if(!existsSync(join(root,'node_modules'))) throw new Error('Execute npm ci antes de validar.');
  if(!full&&!androidOnly) return {runtime:process.version+'/'+process.platform+'/'+process.arch,env:{...process.env,LIONPOCKET_SYNC_INTEGRATION:'0'}};
  if(process.platform!=='linux' || process.arch!=='x64') throw new Error('O pipeline completo requer Linux x64; confira docs/local-validation.md para Windows.');
  const cachedJdk=join(homedir(),'.cache/lionpocket-local-validation/jdk21');
  const javaHome = process.env.JAVA_HOME || (existsSync(join(cachedJdk,'bin/javac')) ? cachedJdk : /java.home = (.*)/.exec(capture('java',['-XshowSettings:properties','-version']))?.[1]?.trim());
  const javaVersion = capture(join(javaHome || '', 'bin/java'),['-version']);
  if(!/version "21\./.test(javaVersion)) throw new Error('Configure JAVA_HOME para JDK 21.');
  if(!existsSync(join(javaHome,'bin/javac')) || !/^javac 21\./.test(capture(join(javaHome,'bin/javac'),['-version']))) throw new Error('JDK 21 completo com javac é necessário; JRE sozinho não compila Android.');
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(),'Android/Sdk');
  for(const file of ['platform-tools/adb','emulator/emulator','cmdline-tools/latest/bin/avdmanager','platforms/android-37.0/android.jar','build-tools/37.0.0/apksigner','ndk/27.1.12297006/source.properties','system-images/android-36/google_apis/x86_64/package.xml'])
    if(!existsSync(join(sdk,file))) throw new Error('Pré-requisito Android ausente: '+file+'. Veja docs/local-validation.md.');
  if(!existsSync('/dev/kvm')) throw new Error('KVM é necessário para o emulador descartável.');
  const docker = capture('docker',['version','--format','{{.Server.Version}}']); capture('docker',['compose','version']);
  const env = {...process.env,JAVA_HOME:javaHome,ANDROID_HOME:sdk,ANDROID_SDK_ROOT:sdk,PATH:[join(sdk,'platform-tools'),join(sdk,'emulator'),join(javaHome,'bin'),process.env.PATH].join(':')};
  return {sdk,env,runtime:JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,java:javaVersion,docker,sdk,javaHome})};
}
async function integration(env,id) {
  env={...env,COMPOSE_PROJECT_NAME:'lion-local-'+id};
  const params=['compose','--project-name',env.COMPOSE_PROJECT_NAME,'-f','tools/sync-dev/compose.yml'];
  try { await run('Iniciar integração isolada','docker',[...params,'up','-d','--wait'],{env}); await npm('Integrações reais','sync:dev:test',{env}); }
  finally { await run('Remover somente fixtures de integração desta execução','docker',[...params,'down','--volumes'],{env,cleanup:true}); }
}
async function checksums(label,artifacts,extensions,env) {
  const directory=mkdtempSync(join(tmpdir(),'lion-local-checksums-'));
  try {
    for(const artifact of artifacts) copyFileSync(join(root,artifact),join(directory,basename(artifact)));
    await node(label,'tools/release/checksums.cjs',[directory,...extensions],{env});
  } finally { rmSync(directory,{recursive:true,force:true}); }
}
async function desktop(env,id) {
  await run('Preparar container Linux de validação','docker',['build','-t','lionpocket-local-desktop','-f','tools/local-validation/Dockerfile.desktop','tools/local-validation'],{env});
  for(const channel of ['normal','private-beta']) {
    const channelEnv={...env,LIONPOCKET_BUILD_CHANNEL:channel};
    await npm('Empacotar Linux '+channel,'make:linux',{env:channelEnv});
    const version=require('../release/validate.cjs').validate().version;
    const executable=channel==='normal'?'lionpocket':'lionpocket-beta',packageName=channel==='normal'?'LionPocket':'LionPocket-Beta';
    await checksums('Checksums Linux '+channel,[`apps/desktop/out/make/deb/x64/${executable}_${version}_amd64.deb`,`apps/desktop/out/make/zip/linux/x64/${packageName}-linux-x64-${version}.zip`],['.deb','.zip'],channelEnv);
    const name='lion-local-desktop-'+id+'-'+channel; containers.add(name);
    await run('SQLite/perfis Linux '+channel,'docker',['run','--rm','--init','--name',name,'--mount','type=bind,src='+root+',dst=/workspace,readonly','-e','LIONPOCKET_BUILD_CHANNEL='+channel,'lionpocket-local-desktop','xvfb-run','-a','node','tools/release/desktop-smoke.cjs'],{env});
    containers.delete(name);
    containers.add(name);
    await run('DEB instalado/protocolo Linux '+channel,'docker',['run','--rm','--init','--name',name,'--mount','type=bind,src='+root+',dst=/workspace,readonly','-e','LIONPOCKET_BUILD_CHANNEL='+channel,'lionpocket-local-desktop','xvfb-run','-a','node','tools/pairing/desktop-deeplink-smoke.cjs'],{env});
    containers.delete(name);
  }
}
const pause = ms=>new Promise(r=>setTimeout(r,ms));
async function available(port) {
  return new Promise(resolvePort=>{const server=net.createServer(); server.once('error',()=>resolvePort(false)); server.listen(port,'127.0.0.1',()=>server.close(()=>resolvePort(true)));});
}
async function android(config,id) {
  const directory=mkdtempSync(join(tmpdir(),'lion-local-android-')), avdHome=join(directory,'avds'); mkdirSync(avdHome);
  const fixtureDirectory=mkdtempSync(join(tmpdir(),'lion-release-fixtures-'));
  const name='LionPocketLocal_'+id.replaceAll('-','');
  const env={...config.env,ANDROID_AVD_HOME:avdHome,LIONPOCKET_LOCAL_VALIDATION_TMP:directory,LIONPOCKET_TEST_SIGNED_APK:join(directory,'LionPocket-EPHEMERAL-ONLY.apk'),LIONPOCKET_ANDROID_FIXTURES:fixtureDirectory,LIONPOCKET_ANDROID_UPGRADE_REPORT:join(directory,'upgrades.json'),LIONPOCKET_ANDROID_COMPATIBILITY_REPORT:join(directory,'compatibility.json'),LIONPOCKET_ANDROID_PREPARATION_REPORT:join(directory,'preparation.json')};
  const androidRoot=join(root,'apps/mobile/android');
  const gradle=(label,params)=>run(label,'./gradlew',[...params,'-PreactNativeArchitectures=x86_64','--no-daemon','--max-workers=2'],{cwd:androidRoot,env});
  let emulator,emulatorLog,serial,verified=false;
  try {
    await gradle('Android debug e instrumentation',[':app:assembleDebug',':app:assembleDebugAndroidTest']);
    await node('Recusar assinatura de produção ausente','tools/release/android-signing-check.cjs',[],{env});
    await gradle('Android normal de desenvolvimento',[':app:assembleRelease','-PdevelopmentSigning=true']);
    await node('Preservar candidato normal','tools/release/android-candidate.cjs',['normal'],{env});
    await gradle('Android beta isolada',[':app:assembleRelease','-PprivateBeta=true']);
    await node('Preservar candidato beta','tools/release/android-candidate.cjs',['private-beta'],{env});
    const version=require('../release/validate.cjs').validate().version;
    await checksums('Checksums Android',[`release-candidates/normal/LionPocket-Android-${version}-DEVELOPMENT-ONLY.apk`,`release-candidates/private-beta/LionPocket-Beta-Android-${version}-DEVELOPMENT-ONLY.apk`],['.apk'],env);
    await node('Assinatura efêmera e pin de certificado','tools/release/android-signing-fixture.cjs',['--build'],{env});
    await node('APKs base em checkout próprio','tools/release/prepare-old-android.cjs',[],{env});
    await run('Fixtures financeiras SQLite',process.execPath,[npmCli,'exec','--','tsx','tools/release/mobile-fixtures.ts',env.LIONPOCKET_ANDROID_FIXTURES],{env});
    await run('Criar somente AVD descartável',join(config.sdk,'cmdline-tools/latest/bin/avdmanager'),['create','avd','--name',name,'--path',join(directory,name+'.avd'),'--package','system-images;android-36;google_apis;x86_64','--device','pixel_6'],{env,input:'no\n'});
    let port;
    for(let candidate=5580;candidate<5680;candidate+=2) if(await available(candidate)&&await available(candidate+1)){port=candidate;break;}
    if(!port) throw new Error('Não há porta livre para o AVD descartável.');
    serial='emulator-'+port; env.ANDROID_SERIAL=serial;
    emulatorLog=openSync(join(directory,'emulator.log'),'w',0o600);
    emulator=spawn(join(config.sdk,'emulator/emulator'),['-avd',name,'-port',String(port),'-no-window','-no-audio','-no-snapshot','-gpu','swiftshader_indirect','-no-boot-anim','-camera-back','none'],{env,stdio:['ignore',emulatorLog,emulatorLog]});
    emulator.on('error',()=>{});
    let ready=false;
    const deadline=Date.now()+10*60*1000;
    while(Date.now()<deadline&&!interrupted&&emulator.exitCode===null) {
      const status=spawnSync('adb',['-s',serial,'shell','getprop','sys.boot_completed'],{env,encoding:'utf8',timeout:10000});
      if(status.stdout?.trim()==='1'){ready=true;break;} await pause(2000);
    }
    if(!ready) throw new Error('O AVD descartável não iniciou. Log: '+join(directory,'emulator.log'));
    if(capture('adb',['-s',serial,'shell','getprop','ro.kernel.qemu'],{env}).trim()!=='1' || !capture('adb',['-s',serial,'emu','avd','name'],{env}).split(/\r?\n/).includes(name)) throw new Error('Identidade do emulador não corresponde ao recurso criado.');
    verified=true;
    await node('Atualizações sem limpar SQLite e storage nativo','tools/release/android-update-ci.cjs',[],{env});
    await node('Deep link Android instalado','tools/pairing/android-deeplink-smoke.cjs',[],{env});
    await node('Exigir relatório do cofre/checkpoint nativo','tools/release/android-secret-store-report.cjs',[],{env});
  } finally {
    if(emulator) {
      if(verified) spawnSync('adb',['-s',serial,'emu','kill'],{env,stdio:'ignore',timeout:10000});
      emulator.kill('SIGTERM');
      await Promise.race([new Promise(r=>emulator.once('close',r)),pause(5000)]);
      if(emulator.exitCode===null) emulator.kill('SIGKILL');
    }
    if(emulatorLog!==undefined) closeSync(emulatorLog);
    if(existsSync(join(directory,'emulator.log'))) {
      const preserved=resolve(root,git(root,['rev-parse','--git-common-dir']),'local-validation','emulator-'+id+'.log');
      copyFileSync(join(directory,'emulator.log'),preserved);
    }
    rmSync(directory,{recursive:true,force:true});
    rmSync(fixtureDirectory,{recursive:true,force:true});
  }
}
async function main() {
  const startedAt=performance.now();
  if(!full&&!androidOnly) budget=createBudget(()=>[...children],()=>{interrupted=true;});
  if(hook) {
    requireIndexMatchesWorktree(root);
    if(hook==='pre-push') {
      requireHeadMatchesIndex(root);
      requirePushTargetsHead(readFileSync(0,'utf8'),git(root,['rev-parse','HEAD']),sha=>git(root,['rev-parse',sha+'^{commit}']));
    }
  }
  const config=configuration(), initial=sourceFingerprint(root);
  const state=resolve(root,git(root,['rev-parse','--git-common-dir']),'local-validation'); mkdirSync(state,{recursive:true});
  const receiptPath=join(state,full||androidOnly?'receipt.json':'quick-receipt.json');
  let receipt; try{receipt=JSON.parse(readFileSync(receiptPath,'utf8'));}catch{}
  if(hook && receiptMatches(receipt,initial,config.runtime) && !budget.expired) { console.log('Checks rápidos aprovados para este conteúdo; recibo reutilizado. Nenhum build ou emulador iniciado.'); return; }
  lock=join(state,'lock');
  try { mkdirSync(lock); } catch { lock=undefined; throw new Error('Outra validação usa este checkout. Aguarde ou verifique o lock local antes de continuar.'); }
  writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:process.pid,startedAt:Date.now()}));
  if(existsSync(receiptPath)) unlinkSync(receiptPath); // A new failure must not leave an older success eligible for hooks.
  const id=randomUUID(); const logPath=join(state,'validation-'+id+'.log'); log=openSync(logPath,'w',0o600);
  console.log('Validação local. Log: '+logPath);
  if(androidOnly) {
    await npm('Bibliotecas para as fixtures Android','build:core',{env:config.env});
    await android(config,id);
    console.log('\nChecks Android aprovados; este comando parcial não autoriza commit/push pelo hook.');
    return;
  }
  await npm(steps[0],'release:validate',{env:config.env});
  if(full) {
    await npm(steps[1],'test',{env:config.env}); await npm(steps[2],'typecheck',{env:config.env}); await npm(steps[3],'lint',{env:config.env});
  } else {
    await npm('Compilar bibliotecas uma única vez','build:core',{env:config.env});
    const results=await Promise.allSettled([npm(steps[1],'test:offline',{env:config.env}),npm(steps[2],'typecheck:offline',{env:config.env}),npm(steps[3],'lint',{env:config.env})]);
    const failed=results.find(result=>result.status==='rejected');
    if(failed) throw failed.reason;
  }
  await run('Whitespace','git',['diff','--check'],{env:config.env}); await run('Whitespace staged','git',['diff','--cached','--check'],{env:config.env});
  if(full) {
    await integration(config.env,id); await npm('Validar Compose','sync:self-hosted:validate',{env:config.env}); await npm('Self-hosted completo','sync:self-hosted:test',{env:config.env});
    await desktop(config.env,id); await android(config,id);
  }
  if(sourceFingerprint(root)!==initial) throw new Error('O código mudou durante a validação. Repita antes de commit/push.');
  if(budget?.expired) throw new Error('Deadline dos checks rápidos atingido.');
  const elapsedMs=Math.round(performance.now()-startedAt);
  const value={formatVersion:1,profile:full?'linux-android':'quick',passed:true,fingerprint:initial,runtime:config.runtime,completedAt:Date.now(),elapsedMs,logPath,coverage:full?steps:steps.slice(0,4),notRun:full?['Windows instalado/protocolo/DPAPI: requer Windows descartável']:['Infraestrutura, pacotes Linux/Windows e emulador Android: ensaios manuais separados']};
  const temporary=receiptPath+'.'+id; writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600}); renameSync(temporary,receiptPath);
  console.log('\nAPROVADO: '+(full?'pipeline completo Linux/Android (Windows não executado)':'checks rápidos, sem infraestrutura/builds nativos')+' em '+(elapsedMs/1000).toFixed(1)+'s.');
}
main().catch(error=>{console.error('\n'+(budget?.expired?'Checks rápidos excederam 55s: execução interrompida, sem aprovação. Nenhuma etapa pesada foi iniciada.':error.message));process.exitCode=1;}).finally(()=>{
  budget?.cancel();
  for(const name of containers) spawnSync('docker',['rm','--force',name],{stdio:'ignore',timeout:30000});
  if(log!==undefined) closeSync(log);
  if(lock) rmSync(lock,{recursive:true,force:true});
});
