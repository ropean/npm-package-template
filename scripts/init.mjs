#!/usr/bin/env node
// One-time setup after creating a repo from this template. Renames the package everywhere,
// resets version/changelog, optionally drops the CLI, then deletes itself.
//
//   node scripts/init.mjs                                — interactive (defaults from folder + git remote)
//   node scripts/init.mjs --name @ropean/foo --description "Does foo" --bin foo --yes
//   node scripts/init.mjs --name foo-lib --no-bin --yes  — pure library, unscoped name
//
// Flags: --name, --description, --bin <cmd> | --no-bin, --repo <owner/repo>, --author, --yes

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

const TEMPLATE = {
  name: '@ropean/npm-package-template',
  repo: 'ropean/npm-package-template',
  bin: 'my-cli',
  description: 'TODO: one-line description',
};

const { values: flags } = parseArgs({
  options: {
    name: { type: 'string' },
    description: { type: 'string' },
    bin: { type: 'string' },
    'no-bin': { type: 'boolean' },
    repo: { type: 'string' },
    author: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
  },
});

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.name !== TEMPLATE.name) {
  console.error(`✗ package.json name is "${pkg.name}" — this repo looks initialized already.`);
  process.exit(1);
}

function gitRemoteRepo() {
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8', stdio: 'pipe' }).trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    return m?.[1];
  } catch {
    return undefined;
  }
}

const folder = basename(process.cwd());
const remote = gitRemoteRepo();
const remoteRepo = remote && remote !== TEMPLATE.repo ? remote : undefined;
const owner = pkg.author || 'ropean';

const interactive = !flags.yes && process.stdin.isTTY;
const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
async function ask(label, given, fallback) {
  if (given !== undefined) return given;
  if (!rl) return fallback;
  const answer = (await rl.question(`${label}${fallback ? ` (${fallback})` : ''}: `)).trim();
  return answer || fallback;
}

const name = await ask('Package name', flags.name, remoteRepo ? `@${remoteRepo}` : `@${owner}/${folder}`);
const unscoped = name.replace(/^@[^/]+\//, '');
const description = await ask('Description', flags.description, '');
const repo = await ask('GitHub repo (owner/name)', flags.repo, remoteRepo ?? `${owner}/${unscoped}`);
const author = await ask('Author', flags.author, pkg.author);
let bin = flags['no-bin'] ? '' : flags.bin;
if (bin === undefined) {
  bin = rl ? await ask('CLI command name (type "-" for a pure library)', undefined, unscoped) : unscoped;
  if (bin === '-') bin = '';
}
rl?.close();

if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) {
  console.error(`✗ "${name}" is not a valid npm package name.`);
  process.exit(1);
}

// ── package.json ────────────────────────────────────────────────────────────
pkg.name = name;
pkg.version = '0.0.1'; // first release publishes this as-is: `pnpm release`
pkg.description = description || TEMPLATE.description;
pkg.author = author;
pkg.homepage = `https://github.com/${repo}#readme`;
pkg.bugs = { url: `https://github.com/${repo}/issues` };
pkg.repository = { type: 'git', url: `git+https://github.com/${repo}.git` };
if (bin) pkg.bin = { [bin]: './dist/cli.mjs' };
else delete pkg.bin;
pkg.scripts['unlink:global'] = `pnpm remove --global ${name}`;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

// ── Text files ──────────────────────────────────────────────────────────────
function rewrite(file, fn) {
  if (existsSync(file)) writeFileSync(file, fn(readFileSync(file, 'utf8')));
}
const replaceAll = (s) =>
  s
    .replaceAll(TEMPLATE.name, name)
    .replaceAll(TEMPLATE.repo, repo)
    .replaceAll(TEMPLATE.bin, bin || unscoped)
    .replaceAll(TEMPLATE.description, description || TEMPLATE.description);

rewrite('README.md', (s) => {
  s = replaceAll(s);
  // Drop the CLI section for pure libraries.
  if (!bin) s = s.replace(/<!-- cli -->[\s\S]*?<!-- \/cli -->\n*/g, '');
  return s.replace(/<!-- \/?cli -->\n/g, '');
});
rewrite('DEVELOPMENT.md', replaceAll);
rewrite('src/cli.ts', replaceAll);
rewrite('LICENSE', (s) => s.replace(/Copyright \(c\) \d{4} .*/, `Copyright (c) ${new Date().getFullYear()} ${author}`));
writeFileSync('CHANGELOG.md', '# Changelog\n');

if (!bin) rmSync('src/cli.ts', { force: true });
rmSync('scripts/init.mjs', { force: true });

console.log(`
✓ Initialized ${name}${bin ? ` (CLI: ${bin})` : ' (library only)'}

Next:
  pnpm install
  pnpm run check
  git add -A && git commit -m "chore: init from npm-package-template"

First publish (v0.0.1):  npm login && pnpm release
`);
