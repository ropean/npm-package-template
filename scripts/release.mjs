#!/usr/bin/env node
// Idempotent, resumable npm release script.
//
// Usage (from repo root):
//   node scripts/release.mjs patch|minor|major       — bump and release
//   node scripts/release.mjs prerelease --preid=beta — 1.2.3 → 1.2.4-beta.0 (published under dist-tag "beta")
//   node scripts/release.mjs 1.4.0                    — explicit version
//   node scripts/release.mjs                          — resume an unfinished release, or no-op if done
//   node scripts/release.mjs --status                 — show where the current version's release stands
//   node scripts/release.mjs --abort                  — abandon an unfinished (unpublished) release
//
// Flags:
//   --yes            skip confirmation prompts (required when not in a TTY)
//   --ci             don't publish locally: bump + changelog + commit + tag + push, and let
//                    .github/workflows/release.yml publish from the tag (npm provenance)
//   --retag          (--ci) CI failed and you committed a fix: move the unpublished tag to HEAD and re-push it
//   --tag=<name>     npm dist-tag (default: "latest", or the preid / "next" for prereleases)
//   --otp=<code>     npm 2FA one-time password (otherwise you're prompted when npm asks for one)
//   --no-smoke       skip the packed-tarball smoke test
//   --no-verify      pass --no-verify to git commit / push (skip git hooks)
//   --force-bump     bump even though the current version was never finished (skip it for good)
//   --tag-only       push the tag but not the branch (protected branches: land the release commit via a PR)
//   --force-tag      overwrite a remote tag that points at a different commit (dangerous)
//   --dir=<path>     package directory (monorepo); also readable from root package.json "release.dir"
//
// Steps (each checks current state first, so re-running after ANY failure resumes safely):
//   1. Preflight   — tools, git identity, clean tree, remote reachable + up to date + pushable,
//                    registry reachable, npm login. Everything that can fail AFTER publish is checked here.
//   2. Version     — bump, or resume the current version if it isn't fully released yet.
//   3. Verify      — `pnpm run check` + smoke test of the packed tarball.
//   4. Publish     — dry-run → confirm → publish; classifies npm errors, retries transient ones,
//                    prompts for OTP, treats "already published" as success.
//   5. Changelog   — prepend a section generated from conventional commits since the last tag.
//   6. Git         — commit, tag, push branch + tag (never force-pushes a tag unless asked).

import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';

// ── Setup ───────────────────────────────────────────────────────────────────

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
const NO_VERIFY = flags['no-verify'] ? ' --no-verify' : '';

const DIR = flags.dir || readJson('package.json')?.release?.dir || '.';
const PKG_PATH = join(DIR, 'package.json');
const CHANGELOG_PATH = join(DIR, 'CHANGELOG.md');
const PKG_NAME = readJson(PKG_PATH).name;
// Always talk to the registry we publish to, even if a mirror (e.g. npmmirror) is configured globally.
const REGISTRY = readJson(PKG_PATH).publishConfig?.registry ?? 'https://registry.npmjs.org/';
const REG = `--registry=${REGISTRY}`;

let step = 'startup';
let publishedThisRun = false;

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

const sh = (cmd, opts = {}) => execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts }).trim();
const trySh = (cmd) => {
  try {
    return sh(cmd);
  } catch {
    return null;
  }
};
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });
const runIn = (cmd) => run(cmd, { cwd: DIR });

/** Run a command, streaming its output live while also capturing it for error classification. */
function runTee(cmd, { cwd = DIR } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (process.stdout.write(d), (output += d)));
    child.stderr.on('data', (d) => (process.stderr.write(d), (output += d)));
    child.on('close', (code) => resolve({ code, output }));
    child.on('error', (e) => resolve({ code: -1, output: `${output}\n${e.message}` }));
  });
}

class ReleaseError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}
const fail = (message, hint) => {
  throw new ReleaseError(message, hint);
};

async function prompt(question) {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim();
  rl.close();
  return answer;
}

async function confirm(question) {
  if (flags.yes) return true;
  const answer = await prompt(`${question} (Y/n) `);
  if (answer === null) fail('Not running in a TTY.', 'Pass --yes to skip confirmation prompts.');
  return !answer || /^y(es)?$/i.test(answer);
}

// ── State queries ───────────────────────────────────────────────────────────

const currentVersion = () => readJson(PKG_PATH).version;
const isPrerelease = (v) => v.includes('-');
const localTagCommit = (v) => trySh(`git rev-parse --verify --quiet "refs/tags/v${v}^{commit}"`);

/** Remote tag → commit sha, or null if absent. Throws if the remote can't be reached. */
function remoteTagCommit(v) {
  const out = sh(`git ls-remote --tags origin "refs/tags/v${v}" "refs/tags/v${v}^{}"`);
  if (!out) return null;
  const lines = out.split('\n').map((l) => l.split(/\s+/));
  // Annotated tags list "<obj> refs/tags/vX" and "<commit> refs/tags/vX^{}" — prefer the peeled commit.
  return (lines.find(([, ref]) => ref.endsWith('^{}')) ?? lines[0])[0];
}

/**
 * 'published' | 'missing'. Throws on anything else (network, auth, registry outage) — a failed
 * lookup must never be mistaken for "not published", or we'd try to publish twice.
 */
function npmState(v) {
  const r = spawnSync(`npm view "${PKG_NAME}@${v}" version --json --prefer-online ${REG}`, {
    shell: true,
    encoding: 'utf8',
  });
  if (r.status === 0) {
    const out = r.stdout.trim();
    if (!out) return 'missing'; // older npm: unknown version → empty output, exit 0
    const parsed = JSON.parse(out);
    return (Array.isArray(parsed) ? parsed.includes(v) : parsed === v) ? 'published' : 'missing';
  }
  if (/E404|404 Not Found|is not in this registry/i.test(r.stderr + r.stdout)) return 'missing';
  fail(
    `Could not query ${REGISTRY} for ${PKG_NAME}@${v}.`,
    `${(r.stderr || r.stdout).trim().split('\n').slice(0, 4).join('\n')}\nCheck your network / proxy and re-run.`,
  );
}
const isPublished = (v) => npmState(v) === 'published';

/** After a publish the registry CDN can lag; poll until the version is visible. */
async function waitUntilVisible(v, seconds = 60) {
  for (let waited = 0; waited <= seconds; waited += 5) {
    try {
      if (isPublished(v)) return true;
    } catch {
      // transient lookup error — keep polling
    }
    await sleep(5000);
  }
  return false;
}

function distTag(version) {
  if (typeof flags.tag === 'string') return flags.tag;
  if (!isPrerelease(version)) return 'latest';
  if (typeof flags.preid === 'string') return flags.preid;
  // 1.2.3-beta.0 → "beta"; 1.2.3-0 → "next"
  const id = version.split('-')[1].split('.')[0];
  return /^[a-z]+$/i.test(id) ? id : 'next';
}

function dirtyFiles() {
  // -z: NUL-separated, untrimmed, unquoted paths ("XY path")
  return execSync('git status --porcelain -z --untracked-files=all', { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((l) => l.slice(3));
}
const OWN_FILES = new Set([PKG_PATH, CHANGELOG_PATH].map((p) => p.replace(/^\.\//, '')));

/** The "chore: release vX" commit in HEAD's history, if any. */
const releaseCommit = (v) =>
  trySh(`git log -n 1 --format=%H --fixed-strings --grep="chore: release v${v}" HEAD`) || null;

// ── Preflight: everything that would otherwise fail AFTER the package is on npm ─

function preflight() {
  step = 'preflight';
  for (const [tool, hint] of [
    ['git --version', 'Install git.'],
    ['pnpm --version', 'Install pnpm: `corepack enable` (or `npm i -g pnpm`).'],
    ['npm --version', 'npm ships with Node.js.'],
  ]) {
    if (!trySh(tool)) fail(`\`${tool.split(' ')[0]}\` not found.`, hint);
  }

  if (!trySh('git rev-parse --git-dir')) fail('Not a git repository.');
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  if (branch === 'HEAD') fail('Detached HEAD.', 'Check out the branch you release from.');
  if (!trySh('git config user.name') || !trySh('git config user.email')) {
    fail('git user.name / user.email not set — the release commit would fail.', 'git config --global user.name "…"');
  }
  if (!trySh('git remote get-url origin')) fail('No "origin" remote.', 'git remote add origin <url>');

  // Only the files this script itself touches may be dirty (that's an interrupted release).
  const dirty = dirtyFiles().filter((f) => !OWN_FILES.has(f));
  if (dirty.length) fail(`Uncommitted changes:\n  ${dirty.join('\n  ')}`, 'Commit or stash them first.');

  // Remote reachable, branch not behind, and we're allowed to push — all BEFORE publishing.
  if (trySh(`git fetch --quiet origin`) === null) {
    fail('Cannot reach the git remote (fetch failed).', 'Check network / credentials: `git fetch origin`.');
  }
  const upstream = trySh('git rev-parse --abbrev-ref --symbolic-full-name @{u}');
  const remoteBranch =
    upstream ?? (trySh(`git rev-parse --verify --quiet origin/${branch}`) ? `origin/${branch}` : null);
  if (remoteBranch) {
    const behind = Number(sh(`git rev-list --count HEAD..${remoteBranch}`));
    if (behind > 0) {
      fail(
        `Branch is ${behind} commit(s) behind ${remoteBranch} — the final push would be rejected.`,
        'git pull --rebase, then re-run.',
      );
    }
  }
  const dry = spawnSync(`git push --dry-run${NO_VERIFY} origin HEAD`, { shell: true, encoding: 'utf8' });
  if (dry.status !== 0) {
    fail('`git push --dry-run` failed — the final push would fail too.', dry.stderr.trim());
  }
  console.log(`→ git: ${branch}${remoteBranch ? ` (up to date with ${remoteBranch})` : ' (new remote branch)'}`);

  if (!CI_MODE) {
    if (trySh(`npm ping ${REG}`) === null) {
      fail(`Registry ${REGISTRY} is unreachable.`, 'Check network / proxy settings, then re-run.');
    }
    const user = trySh(`npm whoami ${REG}`);
    if (!user) fail(`Not logged in to ${REGISTRY}.`, `npm login ${REG}   (or use --ci to publish from GitHub Actions)`);
    console.log(`→ npm: logged in as ${user}`);
  }
}

// ── Publish with error classification ───────────────────────────────────────

const PUBLISH_ERRORS = [
  { kind: 'otp', re: /EOTP|one-time pass|OTP required|requires.*two-factor/i },
  { kind: 'exists', re: /cannot publish over|previously published|EPUBLISHCONFLICT/i },
  {
    kind: 'fatal',
    re: /too similar to existing package|E403.*similar/i,
    hint: 'npm rejected the name as too similar to an existing package. Rename it (use a scope like @you/name).',
  },
  {
    kind: 'fatal',
    re: /E401|ENEEDAUTH|Unable to authenticate|need auth|token.*(expired|revoked)/i,
    hint: `Login expired or token revoked: npm login ${REG}, then re-run.`,
  },
  {
    kind: 'fatal',
    re: /E402|Payment Required/i,
    hint: 'Scoped packages are private by default — publishConfig.access must be "public" (it is in this template).',
  },
  {
    kind: 'fatal',
    re: /E404|Scope not found|not found/i,
    hint: `The scope of "${PKG_NAME}" doesn't exist or you're not a member. Use your own npm username/org as the scope.`,
  },
  {
    kind: 'fatal',
    re: /E403|Forbidden|do not have permission/i,
    hint:
      'Forbidden. Usual causes: you are not a maintainer of this package / org; the account requires 2FA for ' +
      'writes and the token cannot satisfy it (use a granular token with "bypass 2FA" for automation); ' +
      'or the version was unpublished earlier and can never be reused (run with --abort, then bump).',
  },
  {
    kind: 'fatal',
    re: /E413|too large/i,
    hint: 'Tarball too large — check "files" in package.json (`pnpm pack:dry`).',
  },
  {
    kind: 'transient',
    re: /E429|E5\d\d|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network|EPIPE/i,
  },
];

async function publish(target, tag) {
  const base = `pnpm publish --no-git-checks --ignore-scripts --access public --tag ${tag} ${REG}`;
  let otp = typeof flags.otp === 'string' ? flags.otp : null;

  for (let attempt = 1; attempt <= 4; attempt++) {
    const { code, output } = await runTee(`${base}${otp ? ` --otp=${otp}` : ''}`);
    if (code === 0) return;

    const match = PUBLISH_ERRORS.find((e) => e.re.test(output)) ?? { kind: 'unknown' };

    // The request may have reached npm even though the client saw an error — always re-check first.
    if (match.kind === 'exists' || match.kind === 'transient' || match.kind === 'unknown') {
      console.log('→ Checking whether the version made it to npm anyway …');
      if (await waitUntilVisible(target, match.kind === 'exists' ? 60 : 15)) {
        console.log(`→ ${PKG_NAME}@${target} is on npm — treating the publish as successful.`);
        return;
      }
    }

    switch (match.kind) {
      case 'otp': {
        const code = await prompt('npm needs a 2FA one-time password: ');
        if (!code) fail('npm requires a one-time password.', 'Re-run with --otp=<code> (nothing else needs redoing).');
        otp = code;
        continue;
      }
      case 'transient': {
        if (attempt === 4) break;
        const wait = 5 * 2 ** (attempt - 1);
        console.log(`→ Transient registry/network error — retrying in ${wait}s (attempt ${attempt + 1}/4) …`);
        await sleep(wait * 1000);
        continue;
      }
      case 'exists':
        fail(
          `npm says ${PKG_NAME}@${target} already exists, but it is not visible.`,
          'Either it was published moments ago (wait a minute and re-run), or this version number was ' +
            'unpublished earlier and can never be reused — then run with --abort and release a new version.',
        );
        break;
      case 'fatal':
        fail('npm publish failed.', match.hint);
        break;
    }
    fail('npm publish failed.', 'See the npm output above. Nothing after the publish step has run; fix it and re-run.');
  }
}

// ── Changelog ───────────────────────────────────────────────────────────────

function buildChangelogSection(version) {
  const tags = sh('git tag -l "v*" --sort=-v:refname').split('\n').filter(Boolean);
  const prevTag = tags.find((t) => t !== `v${version}`);
  const range = prevTag ? `${prevTag}..HEAD` : 'HEAD';
  const log = (trySh(`git log ${range} --no-merges --pretty=format:%s${DIR === '.' ? '' : ` -- ${DIR}`}`) ?? '')
    .split('\n')
    .filter(Boolean)
    .filter((s) => !s.startsWith('chore: release v') && !s.startsWith('docs: changelog for v'));

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
    else if (['build', 'ci', 'test', 'style'].includes(m[1])) buckets.chore.push(m[4]);
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
  if (existing.includes(`## v${version} `)) return;
  const insertAt = existing.indexOf('\n') + 1;
  const body = existing.slice(insertAt).replace(/^\n+/, '');
  writeFileSync(
    CHANGELOG_PATH,
    `${existing.slice(0, insertAt)}\n${buildChangelogSection(version)}${body}`.trimEnd() + '\n',
  );
  trySh(`npx --no-install prettier --write "${CHANGELOG_PATH}"`);
  console.log(`→ Added CHANGELOG section for v${version}`);
}

// ── Git: commit, tag, push ──────────────────────────────────────────────────

const PUSH_HINTS = [
  [/non-fast-forward|fetch first|\[rejected\]/i, 'The remote moved on: git pull --rebase, then re-run (no args).'],
  [
    /protected branch|GH006|GH013|pre-receive hook declined/i,
    'The branch is protected. Re-run with --tag-only (pushes just the tag), then open a PR for the release commit.',
  ],
  [
    /Permission denied|403|could not read Username|Authentication failed/i,
    'No push access / credentials. Fix git auth, then re-run (no args).',
  ],
  [/hook/i, 'A git hook rejected the push. Fix it, or re-run with --no-verify.'],
];

async function push(cmd) {
  const { code, output } = await runTee(cmd, { cwd: '.' });
  if (code === 0) return;
  const hint = PUSH_HINTS.find(([re]) => re.test(output))?.[1];
  fail(`\`${cmd}\` failed.`, hint ?? 'See git output above; fix it and re-run (no args).');
}

async function gitFinish(target) {
  step = 'git commit';
  const ownDirty = dirtyFiles().filter((f) => OWN_FILES.has(f));
  if (ownDirty.length) {
    run(`git add -- "${PKG_PATH}" "${CHANGELOG_PATH}"`);
    const r = spawnSync(`git commit${NO_VERIFY} -m "chore: release v${target}"`, { shell: true, stdio: 'inherit' });
    if (r.status !== 0)
      fail('git commit failed (often a pre-commit / commit-msg hook).', 'Fix it, or re-run with --no-verify.');
  }

  step = 'git tag';
  // --retag: CI failed and a fix was committed on top — the (unpublished) tag should point at HEAD.
  const want = flags.retag ? sh('git rev-parse HEAD') : (releaseCommit(target) ?? sh('git rev-parse HEAD'));
  const local = localTagCommit(target);
  const remote = remoteTagCommit(target);

  if (remote && remote !== want && !flags['force-tag'] && !flags.retag) {
    fail(
      `Remote tag v${target} points at ${remote.slice(0, 8)}, not at the release commit ${want.slice(0, 8)}.`,
      'Someone (or an earlier attempt) already pushed this tag. Inspect it: `git fetch --tags && git show v' +
        target +
        '`.\nIf yours is right, re-run with --force-tag (this rewrites a public tag).',
    );
  }
  if (!local) {
    run(`git tag -a v${target} -m "v${target}" ${want}`);
  } else if (local !== want && (flags.retag || flags['force-tag'] || !remote || remote !== local)) {
    // Never pushed, or explicitly asked to replace (--retag: unpublished; --force-tag).
    run(`git tag -fa v${target} -m "v${target}" ${want}`);
    console.log(`→ Moved tag v${target} to ${want.slice(0, 8)}`);
  }

  step = 'git push';
  console.log('\n→ Pushing …');
  const hasUpstream = trySh('git rev-parse --abbrev-ref @{u}') !== null;
  if (flags['tag-only']) console.log('→ --tag-only: not pushing the branch (land the release commit via a PR)');
  else await push(`git push${NO_VERIFY}${hasUpstream ? '' : ' -u'} origin HEAD`);
  if (remoteTagCommit(target) !== localTagCommit(target)) {
    await push(`git push${NO_VERIFY} origin refs/tags/v${target}${remote ? ' --force' : ''}`);
  }
}

// ── --status / --abort ──────────────────────────────────────────────────────

function status() {
  const v = currentVersion();
  const local = localTagCommit(v);
  let remote = '?';
  try {
    remote = remoteTagCommit(v);
  } catch {
    // offline
  }
  let npm = '?';
  try {
    npm = npmState(v);
  } catch (e) {
    npm = `unknown (${e.message})`;
  }
  const changelog = existsSync(CHANGELOG_PATH) && readFileSync(CHANGELOG_PATH, 'utf8').includes(`## v${v} `);
  const commit = releaseCommit(v);
  const dirty = dirtyFiles();
  const s = (x) => (x ? '✓' : '·');
  console.log(`${PKG_NAME}@${v}  (registry ${REGISTRY})\n`);
  console.log(`  ${s(npm === 'published')} npm          ${npm}`);
  console.log(`  ${s(changelog)} CHANGELOG    ${changelog ? 'has section' : 'no section yet'}`);
  console.log(`  ${s(commit)} commit       ${commit ? commit.slice(0, 8) : 'no "chore: release" commit'}`);
  console.log(`  ${s(local)} local tag    ${local ? local.slice(0, 8) : 'none'}`);
  console.log(
    `  ${s(remote && remote !== '?')} remote tag   ${remote === '?' ? 'unknown (offline)' : remote ? remote.slice(0, 8) : 'none'}`,
  );
  if (dirty.length) console.log(`\n  uncommitted: ${dirty.join(', ')}`);
  if (remote && remote !== '?' && npm === 'missing') {
    console.log('\n  Tag is pushed but the version is not on npm: CI is publishing, or the release workflow failed.');
    console.log('  → Transient failure: re-run the job in GitHub Actions.');
    console.log('  → Needs a code fix: commit the fix, then `pnpm release --ci --retag`.');
  }
}

async function abort() {
  step = 'abort';
  const v = currentVersion();
  if (isPublished(v)) {
    fail(
      `${PKG_NAME}@${v} is already on npm — it can't be un-released.`,
      'Run `pnpm release` (no args) to finish the git steps, or ship a fix as a new version.\n' +
        `To pull it back: npm deprecate ${PKG_NAME}@${v} "reason"  /  npm dist-tag add ${PKG_NAME}@<good> latest`,
    );
  }
  const remote = remoteTagCommit(v);
  if (!(await confirm(`Abandon the unfinished release v${v}?`))) return;

  if (remote) {
    run(`git push${NO_VERIFY} origin :refs/tags/v${v}`);
    console.log(`→ Deleted remote tag v${v}`);
  }
  if (localTagCommit(v)) run(`git tag -d v${v}`);

  const commit = releaseCommit(v);
  const head = sh('git rev-parse HEAD');
  const upstream = trySh('git rev-parse --abbrev-ref @{u}');
  const pushed = commit && upstream && trySh(`git merge-base --is-ancestor ${commit} ${upstream}`) !== null;
  if (commit && commit === head && !pushed) {
    run('git reset --keep HEAD~1');
    console.log('→ Dropped the local release commit');
  } else if (commit) {
    console.log(
      `→ The release commit ${commit.slice(0, 8)} is ${pushed ? 'already pushed' : 'not on top'} — left as is.`,
    );
    console.log('  Next release: `pnpm release <bump> --force-bump` (skips this version number).');
  }
  run(`git checkout HEAD -- "${PKG_PATH}"`);
  if (existsSync(CHANGELOG_PATH)) trySh(`git checkout HEAD -- "${CHANGELOG_PATH}"`);
  console.log(`✓ Aborted v${v}. package.json is back to ${currentVersion()}.`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (flags.status) return status();
  if (flags.abort) return abort();

  preflight();

  // ── Resolve target version ──
  step = 'version';
  const current = currentVersion();
  const done = (v) => {
    if (v === '0.0.0') return true;
    const tagPushed = localTagCommit(v) && remoteTagCommit(v) !== null;
    return tagPushed && (CI_MODE || isPublished(v));
  };
  const currentDone = !flags.retag && done(current);

  let target = current;
  if (bumpArg && (currentDone || flags['force-bump'])) {
    const preid = typeof flags.preid === 'string' ? ` --preid=${flags.preid}` : '';
    try {
      sh(`npm version ${bumpArg}${preid} --no-git-tag-version --allow-same-version`, { cwd: DIR });
    } catch (e) {
      fail(
        `\`npm version ${bumpArg}\` failed.`,
        `${e.stderr?.trim() ?? e.message}\nUse patch|minor|major|pre*|<x.y.z>.`,
      );
    }
    target = currentVersion();
    console.log(`→ Version: ${current} → ${target}`);
  } else if (bumpArg && !trySh('git tag -l "v*"')) {
    console.log(`→ First release: publishing v${current} as is (ignoring "${bumpArg}").`);
  } else if (bumpArg) {
    console.log(`→ v${current} is not fully released yet — resuming it (ignoring "${bumpArg}").`);
    console.log('  To drop it instead: `pnpm release --abort`, or `--force-bump` to skip this number.');
  } else if (currentDone) {
    console.log(`→ v${current} is already released. Pass patch|minor|major|<version> to cut a new one.`);
    if (CI_MODE && !isPublished(current)) status();
    return;
  } else {
    console.log(`→ ${trySh('git tag -l "v*"') ? 'Resuming release of' : 'First release:'} v${current}`);
  }
  if (target === '0.0.0') fail('Refusing to release 0.0.0.', 'Pass a bump (e.g. `patch`) or an explicit version.');

  const tag = distTag(target);
  const already = !CI_MODE && isPublished(target);
  console.log(`→ ${PKG_NAME}@${target}  (dist-tag: ${tag}${CI_MODE ? ', published by CI' : ''})`);

  // A pushed tag for a version that isn't on npm = a CI release in flight / failed, or someone else's attempt.
  if (!CI_MODE && !already && !flags['force-tag'] && remoteTagCommit(target)) {
    fail(
      `Tag v${target} is already on the remote, but the version is not on npm.`,
      'A CI release may be running or have failed (see GitHub Actions / `pnpm release --status`).\n' +
        'Publish it via CI (`pnpm release --ci --retag` after fixing), or re-run with --force-tag to publish locally.',
    );
  }

  // ── Verify (skipped when the version is already on npm — nothing left to verify) ──
  if (!already) {
    step = 'checks';
    console.log('\n→ Running checks …');
    try {
      runIn('pnpm run check');
      if (!flags['no-smoke']) {
        step = 'smoke test';
        console.log('\n→ Smoke-testing the packed tarball …');
        runIn('node scripts/smoke.mjs --no-build');
      }
    } catch {
      fail(
        `${step} failed.`,
        `package.json stays at ${target} (uncommitted). Fix the problem, commit the fix, then re-run (no args).\n` +
          'To give up on this version: `pnpm release --abort`.',
      );
    }
  }

  // ── Publish ──
  step = 'publish';
  if (CI_MODE) {
    console.log('→ --ci: skipping local publish (the tag push triggers the release workflow)');
  } else if (already) {
    console.log(`→ v${target} already on npm, skipping publish`);
  } else {
    console.log('\n→ Dry run …');
    const dry = await runTee(
      `pnpm publish --no-git-checks --ignore-scripts --access public --tag ${tag} ${REG} --dry-run`,
    );
    if (dry.code !== 0) fail('Dry-run publish failed.', 'See output above.');
    if (!(await confirm(`\nPublish ${PKG_NAME}@${target} to npm with dist-tag "${tag}"?`))) {
      console.log('Aborted before publish. Re-run (no args) to resume, or `pnpm release --abort` to drop it.');
      return;
    }
    await publish(target, tag);
    publishedThisRun = true;
    if (!(await waitUntilVisible(target, 30))) {
      console.log('→ (npm accepted the publish; the registry CDN has not caught up yet — that is normal)');
    }
  }

  // ── Changelog + git ──
  step = 'changelog';
  updateChangelog(target);

  if (flags.retag && isPublished(target)) fail(`v${target} is already on npm — its tag must not move.`);
  await gitFinish(target);

  console.log(`\n✓ ${PKG_NAME}@${target} released${CI_MODE ? ' (tag pushed — CI will publish)' : ''}.`);
  if (REGISTRY.includes('registry.npmjs.org')) console.log(`  https://www.npmjs.com/package/${PKG_NAME}/v/${target}`);
  if (CI_MODE) console.log('  Follow it in GitHub → Actions → Release. Check later with `pnpm release --status`.');
}

let interrupted = false;
process.on('SIGINT', () => {
  interrupted = true; // children get the signal too; main() will throw and we report below
});

main().catch(async (err) => {
  await new Promise((r) => setTimeout(r, 50)); // let a pending SIGINT handler run first
  console.error(`\n✗ ${interrupted ? 'Interrupted' : 'Failed'} during: ${step}`);
  if (!interrupted) console.error(`  ${err.message}`);
  if (err.hint) console.error(`\n  ${err.hint.replace(/\n/g, '\n  ')}`);
  if (!CI_MODE && (publishedThisRun || step.startsWith('git') || step === 'changelog')) {
    console.error(
      `\n  NOTE: ${PKG_NAME}@${currentVersion()} IS ALREADY ON NPM. Only the git bookkeeping is left —\n` +
        '  fix the issue above and run `pnpm release` (no args) to finish. Do not bump again.',
    );
  } else if (step !== 'abort') {
    console.error('\n  Nothing irreversible has happened. Re-run (no args) to resume, or `pnpm release --abort`.');
  }
  console.error('  Current state: `pnpm release --status`');
  process.exit(1);
});
