#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const requiredPrivateNames = new Set([
  '@celsian/platform',
  '@celsian/edge-router',
]);
const allowedPublicNames = new Set([
  '@celsian/adapter-cloudflare',
  '@celsian/adapter-fly',
  '@celsian/adapter-lambda',
  '@celsian/adapter-node',
  '@celsian/adapter-railway',
  '@celsian/adapter-vercel',
  '@celsian/cache',
  '@celsian/cli',
  '@celsian/compress',
  '@celsian/core',
  '@celsian/jwt',
  '@celsian/queue-redis',
  '@celsian/rate-limit',
  '@celsian/rpc',
  '@celsian/schema',
  'celsian',
  'create-celsian',
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
  if (!mustBePrivate && pkg.private !== true && !allowedPublicNames.has(pkg.name)) {
    failures.push(`${file} (${pkg.name || '<unnamed>'}) is not in the allowed public package set`);
  }
}

for (const name of allowedPublicNames) {
  const found = requiredPrivateFiles.some((file) => {
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    return pkg.name === name && pkg.private !== true;
  });
  if (!found) failures.push(`${name} is listed as public but no non-private package manifest was found`);
}

if (failures.length > 0) {
  console.error('Private release assertions failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`OK: Celsian release surface assertions passed for ${allowedPublicNames.size} public packages.`);

function collectPackageJson(dir, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectPackageJson(path, out);
    else if (entry.isFile() && entry.name === 'package.json') out.push(path);
  }
}
