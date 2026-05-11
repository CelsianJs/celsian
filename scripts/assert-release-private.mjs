#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const requiredPrivateNames = new Set([
  '@celsian/platform',
  '@celsian/edge-router',
]);
const requiredPrivateFiles = [];

collectPackageJson('examples', requiredPrivateFiles);
collectPackageJson('packages', requiredPrivateFiles);

const failures = [];
for (const file of requiredPrivateFiles) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const isExample = file.startsWith('examples/');
  const mustBePrivate = isExample || requiredPrivateNames.has(pkg.name);
  if (mustBePrivate && pkg.private !== true) {
    failures.push(`${file} (${pkg.name || '<unnamed>'}) must remain private`);
  }
}

if (failures.length > 0) {
  console.error('Private release assertions failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('OK: Celsian private release assertions passed.');

function collectPackageJson(dir, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectPackageJson(path, out);
    else if (entry.isFile() && entry.name === 'package.json') out.push(path);
  }
}
