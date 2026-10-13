#!/usr/bin/env node
// Scaffold every create-celsian template and run a plain `npm install` in it,
// exactly as a new user does after `npm create celsian@latest`.
//
// Why this exists: verify-publish.sh installs generated apps with npm 11, which
// CI installs on purpose. npm 10, the version bundled with Node 20 and 22, crashed
// on every template's dependency graph ("Cannot read properties of null (reading
// 'edgesOut')") and no gate saw it, because no gate used the npm users have.
// Run this with the npm that ships with the Node under test, before any
// `npm install --global npm@...` step.
//
// Requires a built create-celsian (`pnpm build`). Installs the published
// @celsian/* versions the templates pin, from the npm registry.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const createCelsian = join(root, 'packages/create-celsian/dist/index.js');
const templates = ['full', 'basic', 'rest-api', 'rpc-api'];

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, npm_config_update_notifier: 'false' } });
}

const npmVersion = run('npm', ['--version'], root).stdout.trim();
console.log(`Scaffold install smoke: node ${process.version}, npm ${npmVersion}`);

const work = mkdtempSync(join(tmpdir(), 'celsian-scaffold-npm-'));
let failed = 0;
try {
  for (const template of templates) {
    const name = `smoke-${template}`;
    const scaffolded = run(process.execPath, [createCelsian, name, '--template', template], work);
    if (scaffolded.status !== 0) {
      console.error(`FAIL ${template}: create-celsian exited ${scaffolded.status}\n${scaffolded.stderr}`);
      failed += 1;
      continue;
    }
    const installed = run('npm', ['install', '--no-audit', '--no-fund'], join(work, name));
    if (installed.status !== 0) {
      console.error(`FAIL ${template}: npm ${npmVersion} install exited ${installed.status}`);
      console.error(`${installed.stdout}${installed.stderr}`.trim().split('\n').slice(-15).join('\n'));
      failed += 1;
      continue;
    }
    console.log(`ok   ${template}: npm install`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} of ${templates.length} scaffolded templates failed to install with npm ${npmVersion}.`);
  process.exit(1);
}
console.log(`All ${templates.length} scaffolded templates install with npm ${npmVersion}.`);
