#!/usr/bin/env node
// Idempotent npm release script.
//
// Usage (from repo root):
//   node scripts/release.mjs                         — resume an unfinished release, or no-op if done
//   node scripts/release.mjs patch|minor|major       — bump and release
//   node scripts/release.mjs prerelease --preid=beta — 1.2.3 → 1.2.4-beta.0 (published under dist-tag "beta")
//   node scripts/release.mjs 1.4.0                    — explicit version
//
// Flags:
//   --yes            skip the confirmation prompt (required when not in a TTY)
//   --ci             don't publish locally: bump + changelog + commit + tag + push, and let
//                    .github/workflows/release.yml publish from the tag (npm provenance)
//   --tag=<name>     npm dist-tag (default: "latest", or the preid / "next" for prereleases)
//   --otp=<code>     npm 2FA one-time password (otherwise npm prompts for it)
//   --no-smoke       skip the packed-tarball smoke test
//   --dir=<path>     package directory (monorepo); also readable from root package.json "release.dir"
//
// Steps:
//   1. Preflight: git working tree clean, npm login (local publish only).
//   2. Resolve version: bump, or resume the current one if it isn't fully released yet.
//   3. `pnpm run check` (lint · typecheck · format · test · build · exports) + smoke test.
//   4. Dry-run publish → confirm → publish (skipped if already on npm, or with --ci).
//   5. Prepend a CHANGELOG.md section generated from conventional commits since the last tag.
//   6. Commit, tag v<version>, push branch + tag.
//
// Every step checks current state first, so re-running after any failure picks up where it
// left off: no double bumps, double commits, double tags or "version already published" errors.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : true];
    }),
);
const bumpArg = args.find((a) => !a.startsWith('--'));
const CI_MODE = Boolean(flags.ci);

const sh = (cmd, opts = {}) => execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts }).trim();
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });

const DIR = flags.dir || readJson('package.json')?.release?.dir || '.';
const PKG_PATH = join(DIR, 'package.json');
const CHANGELOG_PATH = join(DIR, 'CHANGELOG.md');
const PKG_NAME = readJson(PKG_PATH).name;
// Always talk to the registry we publish to, even if a mirror (e.g. npmmirror) is configured globally.
const REGISTRY = readJson(PKG_PATH).publishConfig?.registry ?? 'https://registry.npmjs.org/';
const REG = `--registry=${REGISTRY}`;
const runIn = (cmd) => run(cmd, { cwd: DIR });

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function confirm(question) {
  if (flags.yes) return true;
  if (!process.stdin.isTTY) die('Not running in a TTY — pass --yes to skip the confirmation.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} (Y/n) `)).trim().toLowerCase();
  rl.close();
  return !answer || answer === 'y' || answer === 'yes';
}

const currentVersion = () => readJson(PKG_PATH).version;
const isPrerelease = (v) => v.includes('-');
const tagExists = (v) => sh(`git tag -l v${v}`) !== '';
const isPublished = (v) => {
  try {
    return sh(`npm view ${PKG_NAME}@${v} version ${REG}`) === v;
  } catch {
    return false; // E404: package or version not on the registry
  }
};
const remoteTagCommit = (v) => {
  try {
    return sh(`git ls-remote --tags origin refs/tags/v${v}`).split(/\s+/)[0] || null;
  } catch {
    return null;
  }
};

function distTag(version) {
  if (typeof flags.tag === 'string') return flags.tag;
  if (!isPrerelease(version)) return 'latest';
  if (typeof flags.preid === 'string') return flags.preid;
  // 1.2.3-beta.0 → "beta"; 1.2.3-0 → "next"
  const id = version.split('-')[1].split('.')[0];
  return /^[a-z]+$/i.test(id) ? id : 'next';
}

function preflightGit() {
  sh('git rev-parse --git-dir');
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  if (branch === 'HEAD') die('Detached HEAD — check out a branch first.');
  // Only the files this script itself touches may be dirty (that's an interrupted release).
  const allowed = new Set([PKG_PATH, CHANGELOG_PATH].map((p) => p.replace(/^\.\//, '')));
  // -z: NUL-separated, untrimmed, unquoted paths ("XY path")
  const dirty = execSync('git status --porcelain -z --untracked-files=all', { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((l) => l.slice(3))
    .filter((f) => !allowed.has(f));
  if (dirty.length) die(`Working tree has uncommitted changes:\n  ${dirty.join('\n  ')}\nCommit or stash them first.`);
  console.log(`→ git branch: ${branch}`);
}

function ensureNpmLogin() {
  try {
    console.log(`→ npm logged in as ${sh(`npm whoami ${REG}`)}`);
  } catch {
    die('Not logged in to npm. Run `npm login` and try again (or use --ci to publish from GitHub Actions).');
  }
}

function buildChangelogSection(version) {
  const tags = sh('git tag -l "v*" --sort=-v:refname').split('\n').filter(Boolean);
  const prevTag = tags.find((t) => t !== `v${version}`);
  const range = prevTag ? `${prevTag}..HEAD` : 'HEAD';
  let log = [];
  try {
    log = sh(`git log ${range} --no-merges --pretty=format:%s${DIR === '.' ? '' : ` -- ${DIR}`}`)
      .split('\n')
      .filter(Boolean);
  } catch {
    // no commits yet
  }
  log = log.filter((s) => !/^chore: release v/.test(s) && !/^docs: changelog for v/.test(s));

  const groups = {
    breaking: 'Breaking Changes',
    feat: 'Features',
    fix: 'Fixes',
    perf: 'Performance',
    refactor: 'Refactors',
    docs: 'Docs',
    chore: 'Chores',
    other: 'Other',
  };
  const buckets = Object.fromEntries(Object.keys(groups).map((k) => [k, []]));
  for (const subject of log) {
    const m = subject.match(/^(\w+)(\(.+?\))?(!)?:\s*(.+)/);
    if (!m) buckets.other.push(subject);
    else if (m[3]) buckets.breaking.push(m[4]);
    else if (m[1] === 'build' || m[1] === 'ci' || m[1] === 'test' || m[1] === 'style') buckets.chore.push(m[4]);
    else (buckets[m[1]] ?? buckets.other).push(m[4]);
  }

  let section = `## v${version} - ${new Date().toISOString().slice(0, 10)}\n\n`;
  for (const [key, label] of Object.entries(groups)) {
    if (buckets[key].length) section += `### ${label}\n\n${buckets[key].map((l) => `- ${l}`).join('\n')}\n\n`;
  }
  return section;
}

function updateChangelog(version) {
  const existing = existsSync(CHANGELOG_PATH) ? readFileSync(CHANGELOG_PATH, 'utf8') : '# Changelog\n';
  if (existing.includes(`## v${version} `)) return false;
  const insertAt = existing.indexOf('\n') + 1;
  const body = existing.slice(insertAt).replace(/^\n+/, '');
  writeFileSync(
    CHANGELOG_PATH,
    `${existing.slice(0, insertAt)}\n${buildChangelogSection(version)}${body}`.trimEnd() + '\n',
  );
  console.log(`→ Added CHANGELOG section for v${version}`);
  return true;
}

async function main() {
  // ── 1. Preflight ──────────────────────────────────────────────────────────
  preflightGit();
  if (!CI_MODE) ensureNpmLogin();

  // ── 2. Resolve target version ─────────────────────────────────────────────
  const current = currentVersion();
  const released = (v) => tagExists(v) && remoteTagCommit(v) !== null && (CI_MODE || isPublished(v));
  const currentDone = current === '0.0.0' || released(current);

  let target = current;
  if (bumpArg && currentDone) {
    const preid = typeof flags.preid === 'string' ? ` --preid=${flags.preid}` : '';
    runIn(`npm version ${bumpArg}${preid} --no-git-tag-version --allow-same-version`);
    target = currentVersion();
    console.log(`→ Version: ${current} → ${target}`);
  } else if (bumpArg) {
    console.log(`→ v${current} is not fully released yet — resuming it (ignoring "${bumpArg}")`);
  } else if (currentDone) {
    console.log(`→ v${current} is already released. Pass patch|minor|major|<version> to cut a new one.`);
    return;
  } else {
    console.log(`→ Resuming release of v${current}`);
  }
  if (target === '0.0.0') die('Refusing to release 0.0.0 — pass a bump (e.g. `patch`) or an explicit version.');

  const tag = distTag(target);
  console.log(`→ ${PKG_NAME}@${target}  (dist-tag: ${tag}${CI_MODE ? ', published by CI' : ''})`);

  // ── 3. Checks + smoke test ────────────────────────────────────────────────
  console.log('\n→ Running checks …');
  runIn('pnpm run check');
  if (!flags['no-smoke']) {
    console.log('\n→ Smoke-testing the packed tarball …');
    runIn('node scripts/smoke.mjs --no-build');
  }

  // ── 4. Publish ────────────────────────────────────────────────────────────
  if (CI_MODE) {
    console.log('→ --ci: skipping local publish (the tag push triggers the release workflow)');
  } else if (isPublished(target)) {
    console.log(`→ v${target} already on npm, skipping publish`);
  } else {
    const publishCmd = `pnpm publish --no-git-checks --ignore-scripts --access public --tag ${tag} ${REG}`;
    console.log('\n→ Dry run …');
    runIn(`${publishCmd} --dry-run`);
    if (!(await confirm(`\nPublish ${PKG_NAME}@${target} to npm with dist-tag "${tag}"?`))) {
      console.log('Aborted before publish. Re-run the same command to resume.');
      process.exit(0);
    }
    const otp = typeof flags.otp === 'string' ? ` --otp=${flags.otp}` : '';
    runIn(`${publishCmd}${otp}`);
  }

  // ── 5. Changelog ──────────────────────────────────────────────────────────
  const changelogChanged = updateChangelog(target);
  if (changelogChanged) {
    try {
      sh(`npx --no-install prettier --write "${CHANGELOG_PATH}"`);
    } catch {
      // prettier not installed — keep as written
    }
  }

  // ── 6. Commit, tag, push ──────────────────────────────────────────────────
  const dirty = sh(`git status --porcelain -- "${PKG_PATH}" "${CHANGELOG_PATH}"`) !== '';
  if (dirty) {
    run(`git add -- "${PKG_PATH}" "${CHANGELOG_PATH}"`);
    run(`git commit -m "chore: release v${target}"`);
  }

  const head = sh('git rev-parse HEAD');
  if (!tagExists(target)) {
    run(`git tag -a v${target} -m "v${target}"`);
  } else if (sh(`git rev-parse v${target}^{commit}`) !== head && !isPublished(target)) {
    // Stale tag from an abandoned attempt that never reached npm — safe to move.
    run(`git tag -fa v${target} -m "v${target}"`);
    console.log(`→ Moved stale tag v${target} to HEAD`);
  }

  console.log('\n→ Pushing …');
  run('git push origin HEAD');
  const localTag = sh(`git rev-parse v${target}`);
  const remoteTag = remoteTagCommit(target);
  if (remoteTag !== localTag) run(`git push origin v${target}${remoteTag ? ' --force' : ''}`);

  console.log(`\n✓ ${PKG_NAME}@${target} released${CI_MODE ? ' (tag pushed — CI will publish)' : ''}.`);
  if (REGISTRY.includes('registry.npmjs.org')) console.log(`  https://www.npmjs.com/package/${PKG_NAME}/v/${target}`);
}

main().catch((err) => die(err.message));
