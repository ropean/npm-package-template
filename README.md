# @ropean/npm-package-template

TODO: one-line description

[![npm](https://img.shields.io/npm/v/@ropean/npm-package-template.svg)](https://www.npmjs.com/package/@ropean/npm-package-template)
[![CI](https://github.com/ropean/npm-package-template/actions/workflows/ci.yml/badge.svg)](https://github.com/ropean/npm-package-template/actions/workflows/ci.yml)

## Install

```sh
pnpm add @ropean/npm-package-template
```

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
