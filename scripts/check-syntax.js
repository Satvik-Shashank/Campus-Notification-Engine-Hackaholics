'use strict';

// "Build" step: this project ships plain JavaScript, so building means every file must parse.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const roots = ['src', 'tests', 'scripts'];
const files = [];
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
};
roots.forEach(walk);
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed += 1;
    console.error(`SYNTAX ERROR in ${f}\n${r.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} files parse`);
process.exit(failed ? 1 : 0);
