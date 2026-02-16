#!/usr/bin/env node

// create-celsian — Project scaffolder

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { basicTemplate } from './templates/basic.js';
import { restApiTemplate } from './templates/rest-api.js';
import { rpcApiTemplate } from './templates/rpc-api.js';

const templates: Record<string, Record<string, string>> = {
  basic: basicTemplate,
  'rest-api': restApiTemplate,
  'rpc-api': rpcApiTemplate,
};

const args = process.argv.slice(2);
const name = args[0];
const templateFlag = args.indexOf('--template');
const template = templateFlag !== -1 ? args[templateFlag + 1] ?? 'basic' : 'basic';

if (!name) {
  console.log('Usage: create-celsian <project-name> [--template basic|rest-api|rpc-api]');
  console.log('');
  console.log('Templates:');
  console.log('  basic      Minimal API server (default)');
  console.log('  rest-api   REST + TypeBox schemas');
  console.log('  rpc-api    RPC-first with typed client');
  process.exit(1);
}

const files = templates[template];
if (!files) {
  console.error(`Unknown template: ${template}`);
  console.error('Available: basic, rest-api, rpc-api');
  process.exit(1);
}

const dir = join(process.cwd(), name);

console.log(`\nCreating Celsian project: ${name}\n`);

for (const [filePath, content] of Object.entries(files)) {
  const fullPath = join(dir, filePath);
  const fileDir = dirname(fullPath);
  mkdirSync(fileDir, { recursive: true });
  writeFileSync(fullPath, content.replace(/\{\{name\}\}/g, name));
  console.log(`  + ${filePath}`);
}

console.log(`\nDone! Next steps:\n`);
console.log(`  cd ${name}`);
console.log('  npm install');
console.log('  npm run dev');
console.log('');
