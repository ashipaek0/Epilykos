#!/usr/bin/env node
'use strict';
/**
 * npm run check:profile -- profiles/MyInverter.json [more files...]
 * With no file, checks every Modbus profile in profiles/.
 * Exits 1 when any file has an error (warnings alone pass).
 */
const fs = require('fs');
const path = require('path');
const { checkProfile } = require('../modules/profileCheck');

const dir = path.join(__dirname, '..', 'profiles');
let files = process.argv.slice(2);
if (!files.length) files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f));

let errors = 0, warnings = 0;
for (const file of files) {
  let findings;
  try { findings = checkProfile(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (e) { findings = [{ level: 'error', where: 'file', message: `Not valid JSON: ${e.message}` }]; }
  const e = findings.filter(f => f.level === 'error').length, w = findings.length - e;
  errors += e; warnings += w;
  console.log(`${e ? 'FAIL' : 'ok  '} ${path.basename(file)}${e || w ? `  (${e} error${e === 1 ? '' : 's'}, ${w} warning${w === 1 ? '' : 's'})` : ''}`);
  for (const f of findings) console.log(`     ${f.level === 'error' ? 'error' : 'warn '}  ${f.where}: ${f.message}`);
}
console.log(`\n${files.length} file${files.length === 1 ? '' : 's'}, ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
process.exit(errors ? 1 : 0);
