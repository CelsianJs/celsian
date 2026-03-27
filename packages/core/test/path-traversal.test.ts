// @celsian/core — Path traversal prevention tests
// Tests the containment check pattern used in serve.ts and adapter-node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

const TEMP_DIR = resolve(import.meta.dirname ?? __dirname, '__test-static__');
const SECRET_DIR = resolve(TEMP_DIR, '..', '__secret__');

/**
 * Reproduces the path traversal containment check from serve.ts.
 * Returns the file content if allowed, or null if traversal is blocked.
 */
async function tryStaticFile(pathname: string, staticDir: string): Promise<string | null> {
  const decodedPath = decodeURIComponent(pathname);
  const resolvedRoot = resolve(staticDir);
  const filePath = resolve(join(staticDir, decodedPath));

  // Containment check — resolved path must stay within static root
  if (!filePath.startsWith(resolvedRoot + '/') && filePath !== resolvedRoot) {
    return null;
  }

  try {
    const s = await stat(filePath);
    if (s.isFile()) {
      const content = await readFile(filePath, 'utf-8');
      return content;
    }
  } catch {
    // File not found
  }
  return null;
}

describe('Path traversal prevention', () => {
  beforeAll(() => {
    mkdirSync(TEMP_DIR, { recursive: true });
    writeFileSync(join(TEMP_DIR, 'index.html'), '<h1>Hello</h1>');
    mkdirSync(join(TEMP_DIR, 'sub'), { recursive: true });
    writeFileSync(join(TEMP_DIR, 'sub', 'page.html'), '<h1>Sub</h1>');

    mkdirSync(SECRET_DIR, { recursive: true });
    writeFileSync(join(SECRET_DIR, 'secret.txt'), 'TOP SECRET DATA');
  });

  afterAll(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
    rmSync(SECRET_DIR, { recursive: true, force: true });
  });

  it('serves legitimate static files', async () => {
    const result = await tryStaticFile('/index.html', TEMP_DIR);
    expect(result).toBe('<h1>Hello</h1>');
  });

  it('serves files in subdirectories', async () => {
    const result = await tryStaticFile('/sub/page.html', TEMP_DIR);
    expect(result).toBe('<h1>Sub</h1>');
  });

  it('returns null for non-existent files', async () => {
    const result = await tryStaticFile('/nonexistent.html', TEMP_DIR);
    expect(result).toBeNull();
  });

  it('blocks ../ traversal', async () => {
    const result = await tryStaticFile('/../__secret__/secret.txt', TEMP_DIR);
    expect(result).toBeNull();
  });

  it('blocks encoded %2e%2e traversal', async () => {
    const result = await tryStaticFile('/%2e%2e/__secret__/secret.txt', TEMP_DIR);
    expect(result).toBeNull();
  });

  it('blocks double dot traversal to /etc/passwd', async () => {
    const result = await tryStaticFile('/../../../../../../etc/passwd', TEMP_DIR);
    expect(result).toBeNull();
  });

  it('blocks traversal with backslash encoding', async () => {
    const result = await tryStaticFile('/..%5c__secret__%5csecret.txt', TEMP_DIR);
    expect(result).toBeNull();
  });

  it('blocks traversal with mixed encoding', async () => {
    const result = await tryStaticFile('/%2e%2e/%2e%2e/__secret__/secret.txt', TEMP_DIR);
    expect(result).toBeNull();
  });

  it('allows exact root directory (returns null for directory, not file)', async () => {
    const result = await tryStaticFile('/', TEMP_DIR);
    // Root is a directory, not a file, so stat.isFile() returns false
    expect(result).toBeNull();
  });
});
