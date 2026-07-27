// Guards the action SHA pins in .depot/workflows/ against silent rot.
//
// Workflows pin third-party actions to full commit SHAs so a retagged or
// compromised action cannot reach a job holding secrets. Dependabot's
// github-actions ecosystem keeps those pins current, which is what makes
// pinning maintainable rather than a slowly rotting snapshot.
//
// Dependabot only scans .github/workflows/ (plus a root action.yml). It cannot
// be pointed at another directory. Since CI moved to Depot, the workflows that
// run on every PR live in .depot/workflows/, which Dependabot does not see, so
// nothing updates those pins on its own. Within a day of the move, three
// actions shared with .github/workflows/release.yml had already drifted behind.
//
// This script fails when an action used in BOTH trees is pinned to different
// SHAs, so a Dependabot bump to the .github copy cannot land without the .depot
// copy following. Actions that appear ONLY under .depot/ have no upstream
// bumping them at all and are reported as a warning: nothing here can fix that,
// but silence would misrepresent them as covered.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const USES = /uses:\s*([^@\s]+)@([0-9a-f]{40})/g;

function pinsIn(dir) {
  const found = new Map(); // action -> [{sha, file}]
  if (!existsSync(dir)) return found;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const [, action, sha] of text.matchAll(USES)) {
      if (!found.has(action)) found.set(action, []);
      found.get(action).push({ sha, file: join(dir, file) });
    }
  }
  return found;
}

const github = pinsIn(".github/workflows");
const depot = pinsIn(".depot/workflows");

if (depot.size === 0) {
  console.error("No pinned actions found under .depot/workflows/. Has the directory moved?");
  process.exit(1);
}

let failed = false;

// 1. An action pinned twice within the same tree must agree with itself.
for (const [label, tree] of [
  [".github", github],
  [".depot", depot],
]) {
  for (const [action, uses] of tree) {
    const shas = [...new Set(uses.map((u) => u.sha))];
    if (shas.length > 1) {
      failed = true;
      console.error(`INCONSISTENT  ${action} is pinned to ${shas.length} different SHAs inside ${label}/workflows:`);
      for (const u of uses) console.error(`    ${u.sha}  ${u.file}`);
    }
  }
}

// 2. An action used in both trees must be pinned to the same SHA in both.
for (const [action, depotUses] of depot) {
  const githubUses = github.get(action);
  if (!githubUses) continue;
  const depotSha = depotUses[0].sha;
  const githubSha = githubUses[0].sha;
  if (depotSha !== githubSha) {
    failed = true;
    console.error(
      `DRIFT  ${action}\n` +
        `    .github/workflows: ${githubSha}\n` +
        `    .depot/workflows:  ${depotSha}\n` +
        `    Dependabot bumped the .github copy. Apply the same SHA (and version comment) to .depot.`,
    );
  }
}

// 3. Report what nothing is bumping, so it is not mistaken for covered.
const uncovered = [...depot.keys()].filter((a) => !github.has(a));
if (uncovered.length > 0) {
  console.warn(
    `\nNote: ${uncovered.length} action(s) appear only under .depot/workflows/, so Dependabot ` +
      `never proposes updates for them. Review by hand periodically:`,
  );
  for (const a of uncovered) console.warn(`    ${a}@${depot.get(a)[0].sha}`);
}

if (failed) {
  console.error("\nAction pin check FAILED.");
  process.exit(1);
}

console.log(`Action pins consistent (${depot.size} action(s) under .depot/workflows/ checked).`);
