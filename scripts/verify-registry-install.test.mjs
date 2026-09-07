import { afterAll, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildRegistryNpmInstallInvocation,
  isDirectExecution,
  isRetryableRegistryInstallError,
  retryNpmInstall,
  runRegistryNpmInstallOnce,
  summarizeRetryError,
  validateRegistryVersion,
} from './verify-registry-install.mjs';

const temporaryRoots = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

function fakeSleep(record) {
  return async (ms) => {
    record.push(ms);
  };
}

describe('isRetryableRegistryInstallError', () => {
  it('matches npm propagation failures only', () => {
    expect(isRetryableRegistryInstallError(new Error('npm error code ETARGET'))).toBe(true);
    expect(isRetryableRegistryInstallError(new Error('No matching version found for @celsian/adapter-fly@0.6.3.'))).toBe(true);
    expect(isRetryableRegistryInstallError(new Error('npm error code E404'))).toBe(true);
    expect(isRetryableRegistryInstallError(new Error('404 Not Found - GET https://registry.npmjs.org/@celsian%2fadapter-fly'))).toBe(true);

    expect(isRetryableRegistryInstallError(new Error('npm error 401 Unauthorized'))).toBe(false);
    expect(isRetryableRegistryInstallError(new Error('EACCES: permission denied'))).toBe(false);
    expect(isRetryableRegistryInstallError(new Error('ENOSPC: no space left on device'))).toBe(false);
  });
});

describe('retryNpmInstall', () => {
  it('retries retryable failures with the configured delay and returns the recovered result', async () => {
    const sleeps = [];
    const results = [];
    let calls = 0;

    const value = await retryNpmInstall(
      async (attempt) => {
        calls += 1;
        if (attempt < 3) throw new Error('npm error code ETARGET');
        return 'ok';
      },
      { attempts: 4, delayMs: 123, sleep: fakeSleep(sleeps), onAttemptResult: (info) => results.push(info) },
    );

    expect(value).toBe('ok');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([123, 123]);
    expect(results).toMatchObject([
      { attempt: 1, attempts: 4, status: 'failed', retryable: true },
      { attempt: 2, attempts: 4, status: 'failed', retryable: true },
      { attempt: 3, attempts: 4, status: 'passed' },
    ]);
  });

  it('does not retry non-propagation npm failures', async () => {
    const sleeps = [];
    let calls = 0;

    await expect(
      retryNpmInstall(
        async () => {
          calls += 1;
          throw new Error('npm error 401 Unauthorized');
        },
        { attempts: 4, sleep: fakeSleep(sleeps) },
      ),
    ).rejects.toThrow('401 Unauthorized');

    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('validates the attempts option', async () => {
    await expect(retryNpmInstall(async () => 'never', { attempts: 0 })).rejects.toThrow('attempts must be a positive integer');
  });
});

describe('buildRegistryNpmInstallInvocation', () => {
  it('uses online registry metadata and a caller-provided per-run cache', () => {
    const invocation = buildRegistryNpmInstallInvocation('/tmp/celsian-cache', ['@celsian/adapter-fly@0.6.3']);

    expect(invocation.args).toEqual([
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefer-online',
      '--prefer-offline=false',
      '--cache',
      '/tmp/celsian-cache',
      '@celsian/adapter-fly@0.6.3',
    ]);
    expect(invocation.env).toEqual({
      npm_config_cache: '/tmp/celsian-cache',
      npm_config_prefer_online: 'true',
      npm_config_prefer_offline: 'false',
    });
  });
});

describe('runRegistryNpmInstallOnce', () => {
  it('passes the exact npm install flags and environment to the configured command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'celsian-fake-npm-'));
    temporaryRoots.push(root);
    const log = join(root, 'npm-argv.json');
    const fakeNpm = join(root, 'fake-npm.js');
    await writeFile(fakeNpm, [
      '#!/usr/bin/env node',
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: { npm_config_cache: process.env.npm_config_cache, npm_config_prefer_online: process.env.npm_config_prefer_online, npm_config_prefer_offline: process.env.npm_config_prefer_offline } }, null, 2));`,
      'process.exit(0);',
    ].join('\n'));
    await chmod(fakeNpm, 0o755);

    runRegistryNpmInstallOnce(root, ['@celsian/core@0.6.3'], join(root, '.npm-cache'), {
      cmd: process.execPath,
      prefixArgs: [fakeNpm],
    });

    const observed = JSON.parse(await readFile(log, 'utf8'));
    expect(observed.argv).toEqual([
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefer-online',
      '--prefer-offline=false',
      '--cache',
      join(root, '.npm-cache'),
      '@celsian/core@0.6.3',
    ]);
    expect(observed.env).toEqual({
      npm_config_cache: join(root, '.npm-cache'),
      npm_config_prefer_online: 'true',
      npm_config_prefer_offline: 'false',
    });
  });
});

describe('validateRegistryVersion', () => {
  it('accepts exact semver versions', () => {
    expect(validateRegistryVersion('0.6.3')).toBe('0.6.3');
    expect(validateRegistryVersion('1.2.3-rc.1')).toBe('1.2.3-rc.1');
    expect(validateRegistryVersion('1.2.3+build.1')).toBe('1.2.3+build.1');
    expect(validateRegistryVersion(undefined)).toBeUndefined();
  });

  it('rejects tags, ranges, leading-v versions, and malformed prereleases', () => {
    for (const value of ['', 'latest', '^0.6.3', '~0.6.3', 'v0.6.3', 'https://registry.npmjs.org/pkg', '1.2.3-rc..1', '1.2.3-01', '01.2.3']) {
      expect(() => validateRegistryVersion(value)).toThrow('exact semver');
    }
  });
});

describe('summarizeRetryError', () => {
  it('bounds noisy npm output while preserving the registry propagation shape', () => {
    const longError = new Error([
      'npm error code ETARGET',
      'npm error notarget No matching version found for @celsian/adapter-fly@0.6.3.',
      'npm error notarget In most cases you or one of your dependencies are requesting',
      'npm error notarget a package version that does not exist.',
      'npm verbose cwd /tmp/celsian-registry-smoke',
      'npm verbose os Darwin',
    ].join('\n'));

    const summary = summarizeRetryError(longError, { maxLines: 4, maxChars: 220 });

    expect(summary).toContain('npm error code ETARGET');
    expect(summary).toContain('@celsian/adapter-fly@0.6.3');
    expect(summary).not.toContain('npm verbose cwd');
    expect(summary.length).toBeLessThanOrEqual(220);
  });
});

describe('direct execution guard', () => {
  it('does not execute main for an absent or unrelated entrypoint', () => {
    expect(isDirectExecution('/definitely-absent-celsian-checker')).toBe(false);
    expect(isDirectExecution(process.execPath)).toBe(false);
  });

  it('runs main when invoked through a filesystem symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'celsian-registry-guard-'));
    temporaryRoots.push(root);
    const link = join(root, 'verify-registry-link.mjs');
    await symlink(resolve('scripts/verify-registry-install.mjs'), link);

    const res = spawnSync(process.execPath, [link], {
      cwd: resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        CELSIAN_REGISTRY_VERSION: 'latest',
        CELSIAN_REGISTRY_SMOKE_ARTIFACT: join(root, 'failure.json'),
      },
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('CELSIAN_REGISTRY_VERSION must be an exact semver version');
  });
});
