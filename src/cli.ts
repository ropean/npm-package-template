#!/usr/bin/env node
// CLI entry — exposed via "bin" in package.json. Delete this file (and the "bin" field) for a pure library.
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { greet } from './index.js';

const HELP = `Usage: my-cli [name] [options]

Options:
  -l, --loud     Shout the greeting
  -v, --version  Print version
  -h, --help     Show this help`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    loud: { type: 'boolean', short: 'l' },
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(HELP);
} else if (values.version) {
  console.log(pkg.version);
} else {
  console.log(greet(positionals[0] ?? 'world', { loud: values.loud }));
}
