# @ropean/npm-package-template

TODO: one-line description

[![npm](https://img.shields.io/npm/v/@ropean/npm-package-template.svg)](https://www.npmjs.com/package/@ropean/npm-package-template)
[![CI](https://github.com/ropean/npm-package-template/actions/workflows/ci.yml/badge.svg)](https://github.com/ropean/npm-package-template/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@ropean/npm-package-template.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@ropean/npm-package-template.svg)](https://nodejs.org)

<!-- template -->

## Use this template

This repository is a template for new npm packages (TypeScript, ESM + CJS via tsdown, vitest, oxlint, oxfmt,
GitHub Actions releases). Click **Use this template** on GitHub, clone the new repo, then run the init script once:

```sh
node scripts/init.mjs        # asks for name, description and CLI command; deletes itself when done
pnpm install && pnpm run check
```

See [DEVELOPMENT.md](./DEVELOPMENT.md#1-用模板新建一个包) for details (the guide is in Chinese).

<!-- /template -->

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

<!-- ghp -->

### From GitHub Packages

The package is also published to GitHub Packages. GitHub requires an authentication token with the `read:packages`
scope to install from it, even for public packages:

```sh
echo "@ropean:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=<token>" >> ~/.npmrc
npm i -g @ropean/npm-package-template
```

<!-- /ghp -->

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
