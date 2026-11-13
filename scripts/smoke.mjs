#!/usr/bin/env node
// Smoke-test the package exactly as a consumer would get it from npm:
//   1. build (unless --no-build) and `pnpm pack` into a temp dir
//   2. `npm install` that tarball into a fresh throwaway project
//   3. import it as ESM, require() it as CJS (if exported), type-check a TS consumer,
//      and run every "bin" with --help
//
//   node scripts/smoke.mjs             — run, then delete the temp project
//   node scripts/smoke.mjs --keep      — keep the temp project around for poking at
//   node scripts/smoke.mjs --no-build  — reuse the existing dist/
//
// This catches what unit tests can't: missing files in "files", broken "exports",
// wrong bin paths / shebangs, deps that are only devDependencies, etc.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const BUILD = !args.includes('--no-build');
const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const isWin = process.platform === 'win32';

const run = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { stdio: 'pipe', encoding: 'utf8', shell: isWin, ...opts }).trim();

let step = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const section = (msg) => console.log(`\n${++step}. ${msg}`);

const tmp = mkdtempSync(join(tmpdir(), 'smoke-'));
let failed = false;

try {
  if (BUILD) {
    section('Build');
    run('pnpm', ['run', 'build']);
    ok('dist/ built');
  }

  section('Pack');
  run('pnpm', ['pack', '--pack-destination', tmp], { cwd: ROOT });
  const tarball = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('pnpm pack produced no tarball');
  ok(tarball);

  section('Install into a fresh project');
  const app = join(tmp, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'smoke-app', private: true }, null, 2));
  run('npm', ['install', resolve(tmp, tarball), '--no-audit', '--no-fund', '--loglevel=error'], { cwd: app });
  ok(`installed ${pkg.name}@${pkg.version} (+ its runtime dependencies)`);

  const rootExport = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.'];
  const hasEntry = rootExport || pkg.main || pkg.module;

  if (hasEntry) {
    section('Runtime resolution');
    const esm = run(
      'node',
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(pkg.name)}); console.log(Object.keys(m).join(','))`,
      ],
      { cwd: app },
    );
    ok(`import()  → { ${esm} }`);

    const hasRequire = typeof rootExport === 'string' || rootExport?.require || rootExport?.default || pkg.main;
    if (hasRequire) {
      const cjs = run('node', ['-e', `console.log(Object.keys(require(${JSON.stringify(pkg.name)})).join(','))`], {
        cwd: app,
      });
      ok(`require() → { ${cjs} }`);
    }

    const tsc = join(ROOT, 'node_modules', '.bin', isWin ? 'tsc.cmd' : 'tsc');
    if (existsSync(tsc)) {
      section('Types (as seen by a TS consumer with moduleResolution: NodeNext)');
      writeFileSync(
        join(app, 'consumer.mts'),
        `import * as m from ${JSON.stringify(pkg.name)};\nexport const x: object = m;\n`,
      );
      if (hasRequire) {
        writeFileSync(
          join(app, 'consumer.cts'),
          `import m = require(${JSON.stringify(pkg.name)});\nexport const y: object = m;\n`,
        );
      }
      const files = ['consumer.mts', ...(hasRequire ? ['consumer.cts'] : [])];
      run(
        tsc,
        [
          '--noEmit',
          '--strict',
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          '--skipLibCheck',
          'false',
          '--types',
          '',
          ...files,
        ],
        { cwd: app },
      );
      ok(`types resolve for ${files.join(' + ')}`);
    }
  }

  const bins = typeof pkg.bin === 'string' ? { [pkg.name.split('/').pop()]: pkg.bin } : (pkg.bin ?? {});
  if (Object.keys(bins).length) {
    section('Bin entries');
    for (const name of Object.keys(bins)) {
      const bin = join(app, 'node_modules', '.bin', isWin ? `${name}.cmd` : name);
      if (!existsSync(bin)) throw new Error(`bin "${name}" was not linked into node_modules/.bin`);
      const out = run(bin, ['--help'], { cwd: app });
      ok(`${name} --help  → ${out.split('\n')[0]}`);
    }
  }

  console.log('\n✓ Smoke test passed.');
} catch (err) {
  failed = true;
  console.error(`\n✗ Smoke test failed: ${err.message}`);
  if (err.stdout) console.error(err.stdout);
  if (err.stderr) console.error(err.stderr);
} finally {
  if (KEEP) console.log(`\n(kept temp project: ${join(tmp, 'app')})`);
  else rmSync(tmp, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
