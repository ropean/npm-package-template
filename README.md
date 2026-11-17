# @ropean/npm-package-template

TODO: one-line description

[![npm](https://img.shields.io/npm/v/@ropean/npm-package-template.svg)](https://www.npmjs.com/package/@ropean/npm-package-template)
[![CI](https://github.com/ropean/npm-package-template/actions/workflows/ci.yml/badge.svg)](https://github.com/ropean/npm-package-template/actions/workflows/ci.yml)

## Install

```sh
pnpm add @ropean/npm-package-template
```

### From a GitHub Release

Every release also attaches the packed tarball, which is handy when the npm registry is not an option:

```sh
npm i -g https://github.com/ropean/npm-package-template/releases/latest/download/npm-package-template.tgz
```

This URL always points at the latest release. **To update, run the same command again** (`npm update -g` does not
track packages installed from a URL). To pin a version, use
`https://github.com/ropean/npm-package-template/releases/download/vX.Y.Z/npm-package-template.tgz`.

## Usage

```ts
import { greet } from '@ropean/npm-package-template';

greet('world'); // "Hello, world!"
greet('world', { loud: true }); // "HELLO, WORLD!"
```

Works with both `import` (ESM) and `require` (CommonJS); TypeScript types are included.

<!-- cli -->

## CLI

```sh
npx @ropean/npm-package-template --help
# or install globally
pnpm add -g @ropean/npm-package-template
my-cli world --loud
```

<!-- /cli -->

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md).

## License

MIT
