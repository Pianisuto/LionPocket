const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtempSync,writeFileSync,mkdirSync,rmSync,unlinkSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {execFileSync} = require('node:child_process');
const {sourceFingerprint,requireIndexMatchesWorktree,requireHeadMatchesIndex,requirePushTargetsHead,receiptMatches} = require('../local-validation/state.cjs');
function fixture(action) {
  const directory=mkdtempSync(join(tmpdir(),'lion-local-git-test-'));
  const git=args=>execFileSync('git',args,{cwd:directory,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try {
    git(['init','--quiet']); writeFileSync(join(directory,'.gitignore'),'out/\n'); writeFileSync(join(directory,'app.js'),'first'); git(['add','.']);
    git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture']);
    action(directory,git);
  } finally {rmSync(directory,{recursive:true,force:true});}
}
test('source edits, additions and deletions invalidate the exact-content receipt; ignored build output does not',()=>fixture((root,git)=>{
  const first=sourceFingerprint(root); mkdirSync(join(root,'out')); writeFileSync(join(root,'out','bundle.js'),'generated'); assert.equal(sourceFingerprint(root),first);
  writeFileSync(join(root,'app.js'),'second'); assert.notEqual(sourceFingerprint(root),first); writeFileSync(join(root,'app.js'),'first');
  writeFileSync(join(root,'new.js'),'new'); assert.notEqual(sourceFingerprint(root),first); unlinkSync(join(root,'new.js')); assert.equal(sourceFingerprint(root),first);
  unlinkSync(join(root,'app.js')); assert.notEqual(sourceFingerprint(root),first); git(['add','-u']); assert.notEqual(sourceFingerprint(root),first);
}));
test('staged snapshot cannot be approved by tests of a different unstaged file or untracked source',()=>fixture((root,git)=>{
  assert.doesNotThrow(()=>requireIndexMatchesWorktree(root)); writeFileSync(join(root,'app.js'),'edited'); assert.throws(()=>requireIndexMatchesWorktree(root),/não staged/);
  git(['add','.']); assert.doesNotThrow(()=>requireIndexMatchesWorktree(root)); writeFileSync(join(root,'extra.js'),'extra'); assert.throws(()=>requireIndexMatchesWorktree(root),/novos/);
}));
test('push cannot validate staged changes while sending an older HEAD',()=>fixture((root,git)=>{
  assert.doesNotThrow(()=>requireHeadMatchesIndex(root)); writeFileSync(join(root,'app.js'),'next'); git(['add','.']); assert.throws(()=>requireHeadMatchesIndex(root),/HEAD/);
}));
test('push rejects another commit; an annotated tag resolving to tested HEAD is accepted and deletions send no code',()=>{
  const head='a'.repeat(40),other='b'.repeat(40),tag='c'.repeat(40),zero='0'.repeat(40);
  assert.doesNotThrow(()=>requirePushTargetsHead(`refs/tags/test ${tag} refs/tags/test ${zero}`,head,sha=>sha===tag?head:sha));
  assert.throws(()=>requirePushTargetsHead(`refs/heads/other ${other} refs/heads/other ${zero}`,head,sha=>sha),/diferente/);
  assert.doesNotThrow(()=>requirePushTargetsHead(`(delete) ${zero} refs/heads/old ${other}`,head,()=>{throw new Error('must not resolve deleted content');}));
});
test('hooks accept only successful quick checks of the same source/runtime within 24 hours',()=>{
  const now=100000000,receipt={formatVersion:1,profile:'quick',passed:true,fingerprint:'source',runtime:'runtime',completedAt:now-100};
  assert.equal(receiptMatches(receipt,'source','runtime',now),true);
  for(const changed of [{passed:false},{profile:'linux-android'},{fingerprint:'changed'},{runtime:'changed'},{completedAt:now+1},{completedAt:now-86400000},{formatVersion:2}]) assert.equal(receiptMatches({...receipt,...changed},'source','runtime',now),false);
  assert.equal(receiptMatches(undefined,'source','runtime',now),false);
});
test('quick-check deadline kills a stalled child instead of hanging the hook',async()=>{
  const {spawn}=require('node:child_process');
  const {createBudget}=require('../local-validation/budget.cjs');
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:process.platform!=='win32',stdio:'ignore'});
  const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  let timedOut=false;
  const budget=createBudget(()=>[child],()=>{timedOut=true;},100);
  try { const result=await closed; assert.equal(timedOut,true); assert.equal(budget.expired,true); assert.notEqual(result.code,0); }
  finally {budget.cancel();child.kill('SIGKILL');}
});
test('finishing quick checks cancels the deadline without a later timeout',async()=>{
  const {createBudget}=require('../local-validation/budget.cjs');
  let timedOut=false;
  const budget=createBudget(()=>[],()=>{timedOut=true;},20); budget.cancel();
  await new Promise(resolve=>setTimeout(resolve,30)); assert.equal(timedOut,false);
});
test('no executable Actions workflow remains in this checkout',()=>{
  const {existsSync,readdirSync} = require('node:fs');
  const directory=join(__dirname,'../../.github/workflows');
  assert.deepEqual(existsSync(directory)?readdirSync(directory).filter(file=>/\.ya?ml$/.test(file)):[],[]);
});
