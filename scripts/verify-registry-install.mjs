#!/usr/bin/env node
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const packagesDir = join(root, 'packages');
const versionOverride = process.env.CELSIAN_REGISTRY_VERSION;
const artifactPath = process.env.CELSIAN_REGISTRY_SMOKE_ARTIFACT || 'artifacts/registry-smoke.json';

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: opts.cwd ?? root, encoding: 'utf8', stdio: opts.stdio ?? 'pipe' });
  if (res.status !== 0) {
    const details = [res.stdout, res.stderr].filter(Boolean).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed with ${res.status}\n${details}`);
  }
  return res;
}

async function listPackageSpecs() {
  const dirs = run('find', [packagesDir, '-mindepth', '2', '-maxdepth', '2', '-name', 'package.json']).stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  const specs = [];
  const importable = [];
  const bins = [];
  for (const manifest of dirs) {
    const pkg = JSON.parse(await readFile(manifest, 'utf8'));
    if (pkg.private) continue;
    const version = versionOverride || pkg.version;
    specs.push(`${pkg.name}@${version}`);
    if (pkg.exports) importable.push(pkg.name);
    if (typeof pkg.bin === 'string') bins.push((pkg.name || '').split('/').pop());
    if (pkg.bin && typeof pkg.bin === 'object') bins.push(...Object.keys(pkg.bin));
  }
  return { specs, importable, bins };
}

const tmp = await mkdtemp(join(tmpdir(), 'celsian-registry-smoke-'));
try {
  const { specs, importable, bins } = await listPackageSpecs();
  if (specs.length === 0) throw new Error('No public Celsian packages found for registry smoke');

  run('npm', ['init', '-y'], { cwd: tmp });
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...specs], { cwd: tmp });

  if (importable.length > 0) {
    const importCheck = importable.map((name) => `await import(${JSON.stringify(name)});`).join('\n');
    run(process.execPath, ['--input-type=module', '-e', `${importCheck}\nconsole.log('CELSIAN_REGISTRY_IMPORT_OK');`], { cwd: tmp });
  }

  for (const bin of bins) {
    if (!existsSync(join(tmp, 'node_modules/.bin', bin))) {
      throw new Error(`Expected installed binary ${bin} in registry smoke consumer`);
    }
  }

  function smokeGeneratedApp(appDir) {
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...specs], { cwd: appDir });
    run('npm', ['run', 'build'], { cwd: appDir });
  }

  const createCelsianBin = realpathSync(join(tmp, 'node_modules/.bin/create-celsian'));
  for (const template of ['basic', 'rest-api', 'rpc-api']) {
    const appName = `registry-create-celsian-${template}-smoke`;
    const scaffold = run(createCelsianBin, [appName, '--template', template], { cwd: tmp });
    if (!scaffold.stdout.includes(appName)) {
      throw new Error(`create-celsian registry scaffold smoke did not report generated app; stdout=${JSON.stringify(scaffold.stdout)} stderr=${JSON.stringify(scaffold.stderr)}`);
    }
    smokeGeneratedApp(join(tmp, appName));
  }

  const celsianBin = realpathSync(join(tmp, 'node_modules/.bin/celsian'));
  for (const template of ['basic', 'rest-api', 'rpc-api']) {
    const appName = `registry-celsian-cli-${template}-smoke`;
    run(celsianBin, ['create', appName, '--template', template], { cwd: tmp });
    smokeGeneratedApp(join(tmp, appName));
  }

  const artifact = {
    status: 'passed',
    generatedAt: new Date().toISOString(),
    packageCount: specs.length,
    packages: specs,
    checks: ['npm install --ignore-scripts', 'esm imports', 'binary presence', 'create-celsian scaffold/build', '@celsian/cli scaffold/build'],
  };
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`OK: registry smoke installed ${specs.length} Celsian package(s)`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
