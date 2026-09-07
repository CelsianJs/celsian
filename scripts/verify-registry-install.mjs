#!/usr/bin/env node
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const packagesDir = join(root, 'packages');
const artifactPath = process.env.CELSIAN_REGISTRY_SMOKE_ARTIFACT || 'artifacts/registry-smoke.json';
const installAttempts = Math.max(1, Number.parseInt(process.env.CELSIAN_REGISTRY_INSTALL_ATTEMPTS || '20', 10));
const installRetryDelayMs = Math.max(0, Number.parseInt(process.env.CELSIAN_REGISTRY_INSTALL_RETRY_DELAY_MS || '15000', 10));
const completedChecks = [];
const installAttemptLog = [];

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? root,
    encoding: 'utf8',
    stdio: opts.stdio ?? 'pipe',
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  if (res.status !== 0) {
    const details = [res.stdout, res.stderr].filter(Boolean).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed with ${res.status}\n${details}`);
  }
  return res;
}

export function validateRegistryVersion(value) {
  if (value === undefined) return undefined;
  const match = typeof value === 'string' && value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match || match[4]?.split('.').some((part) => /^0\d+$/.test(part))) {
    throw new Error(`CELSIAN_REGISTRY_VERSION must be an exact semver version without a leading "v"; got ${JSON.stringify(value)}`);
  }
  return value;
}

export function isRetryableRegistryInstallError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return /(?:npm error code\s+ETARGET|npm ERR! code ETARGET|\bETARGET\b|npm error code\s+E404|npm ERR! code E404|\bE404\b|No matching version found|npm error 404|npm ERR! 404|404 Not Found)/i.test(message);
}

export async function retryNpmInstall(task, options = {}) {
  const attempts = options.attempts ?? installAttempts;
  const delayMs = options.delayMs ?? installRetryDelayMs;
  const isRetryable = options.isRetryable ?? isRetryableRegistryInstallError;
  const onAttemptResult = options.onAttemptResult ?? (() => {});
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`retryNpmInstall: attempts must be a positive integer, got ${attempts}`);
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await task(attempt);
      onAttemptResult({ attempt, attempts, status: 'passed' });
      return result;
    } catch (error) {
      const retryable = isRetryable(error);
      onAttemptResult({ attempt, attempts, status: 'failed', retryable, error });
      if (!retryable || attempt === attempts) throw error;
      await sleep(delayMs);
    }
  }
  throw new Error('retryNpmInstall: exhausted attempts without a result');
}

export function summarizeRetryError(error, { maxLines = 8, maxChars = 1600 } = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const bounded = message.split('\n').slice(0, maxLines).join('\n');
  return bounded.length > maxChars ? `${bounded.slice(0, maxChars - 1)}…` : bounded;
}

export function buildRegistryNpmInstallInvocation(cacheDir, extraArgs = [], options = {}) {
  return {
    cmd: options.cmd || 'npm',
    args: [
      ...(options.prefixArgs ?? []),
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefer-online',
      '--prefer-offline=false',
      '--cache',
      cacheDir,
      ...extraArgs,
    ],
    env: {
      npm_config_cache: cacheDir,
      npm_config_prefer_online: 'true',
      npm_config_prefer_offline: 'false',
    },
  };
}

export function runRegistryNpmInstallOnce(cwd, extraArgs, cacheDir, options = {}) {
  const install = buildRegistryNpmInstallInvocation(cacheDir, extraArgs, options);
  return run(install.cmd, install.args, { cwd, env: install.env });
}

async function runNpmInstallWithRetry(cwd, extraArgs, label, cacheDir) {
  return retryNpmInstall(
    () => runRegistryNpmInstallOnce(cwd, extraArgs, cacheDir),
    {
      onAttemptResult: ({ attempt, attempts, status, retryable, error }) => {
        if (status === 'passed') {
          installAttemptLog.push({ attempt, label, status });
          return;
        }
        installAttemptLog.push({
          attempt,
          label,
          status,
          retryable,
          message: summarizeRetryError(error),
        });
        if (retryable && attempt < attempts) {
          console.warn(`Registry lookup (${label}) attempt ${attempt}/${attempts} failed; revalidating metadata in ${installRetryDelayMs}ms`);
          console.warn(summarizeRetryError(error));
        }
      },
    },
  );
}

async function listPackageSpecs() {
  const dirs = run('find', [packagesDir, '-mindepth', '2', '-maxdepth', '2', '-name', 'package.json']).stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  const specs = [];
  const importable = [];
  const bins = [];
  const versionOverride = validateRegistryVersion(process.env.CELSIAN_REGISTRY_VERSION);
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

async function writeArtifact(status, specs, extra = {}) {
  const artifact = {
    status,
    generatedAt: new Date().toISOString(),
    packageCount: specs.length,
    packages: specs,
    installAttempts: installAttemptLog,
    checks: completedChecks,
    ...extra,
  };
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
}

export async function main() {
  completedChecks.length = 0;
  installAttemptLog.length = 0;
  const tmp = await mkdtemp(join(tmpdir(), 'celsian-registry-smoke-'));
  const cacheDir = join(tmp, '.npm-registry-cache');
  let specs = [];
  try {
    const packageList = await listPackageSpecs();
    specs = packageList.specs;
    const { importable, bins } = packageList;
    if (specs.length === 0) throw new Error('No public Celsian packages found for registry smoke');

    run('npm', ['init', '-y'], { cwd: tmp });
    await runNpmInstallWithRetry(tmp, specs, 'registry packages', cacheDir);
    completedChecks.push('npm install --ignore-scripts --no-audit --no-fund --prefer-online --prefer-offline=false --cache <per-run-cache>');

    if (importable.length > 0) {
      const importCheck = importable.map((name) => `await import(${JSON.stringify(name)});`).join('\n');
      run(process.execPath, ['--input-type=module', '-e', `${importCheck}\nconsole.log('CELSIAN_REGISTRY_IMPORT_OK');`], { cwd: tmp });
      completedChecks.push('esm imports');
    }

    for (const bin of bins) {
      if (!existsSync(join(tmp, 'node_modules/.bin', bin))) {
        throw new Error(`Expected installed binary ${bin} in registry smoke consumer`);
      }
    }
    completedChecks.push('binary presence');

    async function smokeGeneratedApp(appDir, healthCheck = false) {
      // Install the scaffolded app's own manifest only. Passing package specs here would mask
      // missing template dependencies by installing undeclared @celsian/* packages.
      await runNpmInstallWithRetry(appDir, [], 'generated app', join(appDir, '.npm-registry-cache'));
      run('npm', ['run', 'build'], { cwd: appDir });
      if (healthCheck) {
        run(process.execPath, [join(root, 'scripts/smoke-start-health.mjs')], { cwd: appDir });
      }
    }

    const createCelsianBin = realpathSync(join(tmp, 'node_modules/.bin/create-celsian'));
    {
      const appName = 'registry-create-celsian-default-smoke';
      const scaffold = run(createCelsianBin, [appName], { cwd: tmp });
      if (!scaffold.stdout.includes(appName)) {
        throw new Error(`create-celsian registry scaffold smoke did not report generated app; stdout=${JSON.stringify(scaffold.stdout)} stderr=${JSON.stringify(scaffold.stderr)}`);
      }
      await smokeGeneratedApp(join(tmp, appName), true);
    }
    for (const template of ['full', 'basic', 'rest-api', 'rpc-api']) {
      const appName = `registry-create-celsian-${template}-smoke`;
      const scaffold = run(createCelsianBin, [appName, '--template', template], { cwd: tmp });
      if (!scaffold.stdout.includes(appName)) {
        throw new Error(`create-celsian registry scaffold smoke did not report generated app; stdout=${JSON.stringify(scaffold.stdout)} stderr=${JSON.stringify(scaffold.stderr)}`);
      }
      await smokeGeneratedApp(join(tmp, appName), template === 'full');
    }

    const celsianBin = realpathSync(join(tmp, 'node_modules/.bin/celsian'));
    {
      const appName = 'registry-celsian-cli-default-smoke';
      run(celsianBin, ['create', appName], { cwd: tmp });
      await smokeGeneratedApp(join(tmp, appName), true);
    }
    for (const template of ['basic', 'rest-api', 'rpc-api']) {
      const appName = `registry-celsian-cli-${template}-smoke`;
      run(celsianBin, ['create', appName, '--template', template], { cwd: tmp });
      await smokeGeneratedApp(join(tmp, appName));
    }

    completedChecks.push('create-celsian default/full scaffold build/start/health');
    completedChecks.push('@celsian/cli default scaffold build/start/health');
    completedChecks.push('@celsian/cli basic/rest-api/rpc-api scaffold builds');
    completedChecks.push('scaffold manifest-only installs');
    await writeArtifact('passed', specs);
    console.log(`OK: registry smoke installed ${specs.length} Celsian package(s)`);
  } catch (err) {
    await writeArtifact('failed', specs, {
      error: summarizeRetryError(err, { maxLines: 12, maxChars: 2400 }),
    });
    throw err;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export function isDirectExecution(entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  await main();
}
