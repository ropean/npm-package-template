#!/usr/bin/env node
// Run every pre-flight check in sequence and print one summary line each.
// Output is captured; failed checks dump their output at the end.
//
//   node scripts/check.mjs            — run all checks
//   node scripts/check.mjs --bail     — stop at the first failure
//
// Exit code = number of failed checks (0 == clean).

import { spawn } from 'node:child_process';

const CHECKS = ['lint', 'typecheck', 'format:check', 'test', 'build', 'check:exports'];
const BAIL = process.argv.includes('--bail');

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const C = { dim: c(2), bold: c(1), red: c(31), green: c(32) };

const fmtMs = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

function runScript(name) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn('pnpm', ['run', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, FORCE_COLOR: tty ? '1' : '0' },
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => resolve({ name, code, ms: Date.now() - start, output }));
    child.on('error', (e) => resolve({ name, code: -1, ms: Date.now() - start, output: `${output}\n${e.message}` }));
  });
}

const PAD = Math.max(...CHECKS.map((n) => n.length));
console.log(C.bold(`Running ${CHECKS.length} checks…\n`));

const results = [];
for (const name of CHECKS) {
  if (tty) process.stdout.write(`  ${C.dim('…')} ${name.padEnd(PAD)}  ${C.dim('running')}`);
  const r = await runScript(name);
  results.push(r);
  const badge = r.code === 0 ? C.green('PASS') : C.red('FAIL');
  process.stdout.write(`${tty ? '\r\x1b[K' : ''}  ${badge} ${name.padEnd(PAD)}  ${C.dim(fmtMs(r.ms))}\n`);
  if (r.code !== 0 && BAIL) break;
}

const failed = results.filter((r) => r.code !== 0);
for (const r of failed) {
  console.log(`\n${C.red(C.bold(`── ${r.name} output ──`))}\n${r.output.trim()}`);
}

const total = results.reduce((s, r) => s + r.ms, 0);
console.log(
  `\n${C.bold('Summary')}  ${results.length - failed.length}/${CHECKS.length} passed  ${C.dim(`(${fmtMs(total)})`)}`,
);
console.log(failed.length ? C.red(C.bold('Checks failed.')) : C.green(C.bold('All checks passed.')));
process.exit(failed.length);
