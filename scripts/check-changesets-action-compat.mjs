#!/usr/bin/env node
/**
 * The Changesets GitHub Action major is coupled to the Changesets CLI major,
 * and nothing in the repository expresses that coupling.
 *
 * Two independent ways to break the release, both of which happened:
 *
 *   1. Action v2 refuses to run against CLI v2. It exits with "This version of
 *      the Changesets action is designed to work with Changesets CLI v3".
 *   2. Action v2 renamed every input the workflow passes (`publish` ->
 *      `publish-script`, `title` -> `pr-title`, `commit` -> `commit-message`).
 *      An unknown input is NOT an error in GitHub Actions, so a version bump
 *      that leaves the old names silently falls back to the action's defaults:
 *      no publish script at all. The release job goes green and nothing
 *      reaches npm.
 *
 * The release workflow only runs on pushes to main, so both failures land
 * after merge, when the pull request that caused them is already green. This
 * check runs in the ordinary test workflow so the pairing is verified on the
 * pull request instead.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = join(repoRoot, '.github/workflows/release.yml');

/** Action major -> the CLI major it supports and the input names it accepts. */
const CONTRACTS = {
  1: { cliMajor: 2, inputs: ['publish', 'title', 'commit'] },
  2: { cliMajor: 3, inputs: ['publish-script', 'pr-title', 'commit-message'] },
};

const problems = [];

const workflow = readFileSync(workflowPath, 'utf8');

// `uses: changesets/action@<sha> # v1.9.0` - the major comes from the trailing
// comment, because a pinned SHA carries no version on its own.
const usesMatch = workflow.match(
  /uses:\s*changesets\/action@([0-9a-f]{40}|v\d[\w.]*)\s*#\s*v(\d+)[\w.]*/,
);

if (!usesMatch) {
  problems.push(
    'Could not find a `uses: changesets/action@<ref> # v<major>` line in ' +
      '.github/workflows/release.yml. Pin the action to a commit SHA and put ' +
      'the version in a trailing comment, so this check can read the major.',
  );
} else {
  const actionMajor = Number(usesMatch[2]);
  const contract = CONTRACTS[actionMajor];

  if (!contract) {
    problems.push(
      `changesets/action v${actionMajor} is not a major this check knows about. ` +
        'Add its CLI requirement and input names to CONTRACTS in this script ' +
        'before using it.',
    );
  } else {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const range =
      pkg.devDependencies?.['@changesets/cli'] ?? pkg.dependencies?.['@changesets/cli'];

    if (!range) {
      problems.push('No @changesets/cli dependency found in the root package.json.');
    } else {
      const cliMajor = Number(range.replace(/^\D*/, '').split('.')[0]);
      if (cliMajor !== contract.cliMajor) {
        problems.push(
          `changesets/action v${actionMajor} requires Changesets CLI v${contract.cliMajor}, ` +
            `but the root package.json pins "${range}" (v${cliMajor}). ` +
            'The action refuses to run against the wrong CLI major, and the ' +
            'release job is the only place that would tell you.',
        );
      }
    }

    // The step's inputs live between the `uses:` line and the `env:` that
    // follows it. Read only that window so unrelated `with:` blocks elsewhere
    // in the workflow cannot match.
    const stepStart = usesMatch.index;
    const stepEnd = workflow.indexOf('\n        env:', stepStart);
    const step = workflow.slice(stepStart, stepEnd === -1 ? undefined : stepEnd);

    for (const input of contract.inputs) {
      if (!new RegExp(`^\\s+${input}:`, 'm').test(step)) {
        problems.push(
          `changesets/action v${actionMajor} takes the input "${input}", which the ` +
            'release step does not pass. An unrecognised input is not an error ' +
            'in Actions, so a missing one means the action silently uses its ' +
            'default and the release looks like it succeeded.',
        );
      }
    }

    const otherMajor = actionMajor === 1 ? 2 : 1;
    for (const stale of CONTRACTS[otherMajor].inputs) {
      if (new RegExp(`^\\s+${stale}:`, 'm').test(step)) {
        problems.push(
          `The release step passes "${stale}", which belongs to ` +
            `changesets/action v${otherMajor}, not the pinned v${actionMajor}. ` +
            'It will be ignored silently.',
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error('Changesets action and CLI are not a compatible pair:\n');
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

console.log('OK: the Changesets action major, the CLI major and the step inputs agree.');
