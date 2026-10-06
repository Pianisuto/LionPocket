const {execFileSync} = require('node:child_process');
const {readFileSync,lstatSync,readlinkSync} = require('node:fs');
const {createHash} = require('node:crypto');
const {join} = require('node:path');
function git(root,args) { return execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim(); }
function sourceFingerprint(root) {
  const files = execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root}).toString().split('\0').filter(Boolean);
  const digest = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    digest.update(file+'\0');
    const path = join(root,file);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if(error.code!=='ENOENT') throw error; digest.update('deleted\0'); continue; }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Entrada Git não suportada: '+file);
    digest.update((stat.isSymbolicLink()?'symlink':'file')+'\0'+String(stat.mode & 0o111)+'\0');
    digest.update(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
    digest.update('\0');
  }
  return digest.digest('hex');
}
function requireIndexMatchesWorktree(root) {
  try { execFileSync('git',['diff','--quiet'],{cwd:root,stdio:'ignore'}); }
  catch { throw new Error('Há mudanças não staged. Adicione o conteúdo que será commitado antes da validação do hook.'); }
  if (execFileSync('git',['ls-files','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).trim())
    throw new Error('Há arquivos novos não staged. Adicione-os ou declare-os no .gitignore antes de validar o commit.');
}
function requirePushTargetsHead(input,head,resolveCommit) {
  for(const line of input.trim().split('\n').filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if(fields.length!==4) throw new Error('Referência de push inválida.');
    if(/^0+$/.test(fields[1])) continue; // Deleting a remote ref sends no executable content.
    if(resolveCommit(fields[1])!==head) throw new Error('O push inclui conteúdo diferente de HEAD. Valide essa referência em um checkout próprio.');
  }
}
function requireHeadMatchesIndex(root) {
  try { execFileSync('git',['diff','--cached','--quiet','HEAD'],{cwd:root,stdio:'ignore'}); }
  catch { throw new Error('Há alterações staged ainda não commitadas. O push precisa validar exatamente HEAD.'); }
}
function receiptMatches(receipt,fingerprint,runtime,now=Date.now(),profile='quick') {
  return Boolean(receipt && receipt.formatVersion===1 && receipt.profile===profile &&
    receipt.fingerprint===fingerprint && receipt.runtime===runtime &&
    Number.isFinite(receipt.completedAt) && receipt.completedAt<=now && now-receipt.completedAt<24*60*60*1000 &&
    receipt.passed===true);
}
module.exports = {git,sourceFingerprint,requireIndexMatchesWorktree,requireHeadMatchesIndex,requirePushTargetsHead,receiptMatches};
