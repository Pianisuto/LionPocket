const {test} = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {readFileSync,existsSync} = require('node:fs');
const {resolve} = require('node:path');
test('only current invitation format exists in tracked and new repository content',() => {
  const root = resolve(__dirname,'../..');
  const unsupported = String.fromCharCode(76,80,86,49);
  const files = execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root}).toString().split('\0').filter(Boolean);
  const found = [];
  for(const file of new Set(files)) {
    const path = resolve(root,file); if(!existsSync(path)) continue;
    const data = readFileSync(path); if(data.includes(0)) continue;
    if(data.toString().includes(unsupported)) found.push(file);
  }
  assert.deepEqual(found,[],'Obsolete invitation format was reintroduced');
});
