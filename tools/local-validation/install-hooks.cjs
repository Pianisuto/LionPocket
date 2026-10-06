const {execFileSync} = require('node:child_process');
const {chmodSync, existsSync} = require('node:fs');
const {resolve} = require('node:path');
const root = resolve(__dirname,'../..');
try { execFileSync('git',['rev-parse','--git-dir'],{cwd:root,stdio:'ignore'}); }
catch { console.log('Sem checkout Git: hooks locais não instalados.'); process.exit(0); }
let existing = '';
try { existing = execFileSync('git',['config','--get','core.hooksPath'],{cwd:root,encoding:'utf8'}).trim(); } catch {}
if (existing && existing !== '.githooks') throw new Error('core.hooksPath já aponta para '+existing+'. Integre os hooks existentes antes de instalar.');
for (const name of ['pre-commit','pre-push']) {
  const file = resolve(root,'.githooks',name);
  if (!existsSync(file)) throw new Error('Hook ausente: '+name);
  chmodSync(file,0o755);
}
execFileSync('git',['config','--local','core.hooksPath','.githooks'],{cwd:root});
console.log('Hooks locais pre-commit/pre-push instalados. GitHub Actions não é utilizado.');
