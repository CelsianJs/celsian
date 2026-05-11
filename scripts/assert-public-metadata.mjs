#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const packagesDir = new URL('../packages/', import.meta.url);
const expected = {
  repository: 'git+https://github.com/CelsianJs/celsian.git',
  homepage: 'https://github.com/CelsianJs/celsian#readme',
  bugs: 'https://github.com/CelsianJs/celsian/issues',
};

const failures = [];
for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(packagesDir.pathname, entry.name, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    continue;
  }
  if (pkg.private) continue;
  if (pkg.repository?.url !== expected.repository) {
    failures.push(`${pkg.name}: repository.url is ${JSON.stringify(pkg.repository?.url)}`);
  }
  if (pkg.homepage !== expected.homepage) {
    failures.push(`${pkg.name}: homepage is ${JSON.stringify(pkg.homepage)}`);
  }
  if (pkg.bugs?.url !== expected.bugs) {
    failures.push(`${pkg.name}: bugs.url is ${JSON.stringify(pkg.bugs?.url)}`);
  }
}

if (failures.length > 0) {
  console.error(`Public package metadata check failed:\n${failures.join('\n')}`);
  process.exit(1);
}

console.log('OK: public package metadata points to github.com/CelsianJs/celsian');
