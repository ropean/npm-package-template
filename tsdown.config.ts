import { existsSync } from 'node:fs';
import type { UserConfig } from 'tsdown';

const configs: UserConfig[] = [
  // Library: dual ESM + CJS with matching .d.mts / .d.cts.
  // Going ESM-only? Use `format: ['esm']` and drop the "require" / "main" fields in package.json.
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    platform: 'node',
    target: 'node22',
    dts: true,
    sourcemap: true,
    clean: true,
  },
];

// CLI: only built when src/cli.ts exists — delete that file for a pure library.
if (existsSync('src/cli.ts')) {
  configs.push({
    entry: ['src/cli.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    dts: false,
    sourcemap: true,
    clean: false,
  });
}

export default configs;
