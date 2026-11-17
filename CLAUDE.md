# CLAUDE.md

Guidance for Claude Code (and other contributors) working in this repository.

<!-- template -->

## This is a template project

`@ropean/npm-package-template` is a GitHub template for new npm packages. Changes here are copied into every
package created from it, so keep everything generic and free of project-specific content.

- **Do NOT add the `packageManager` or `devEngines` fields to `package.json`.** The pnpm version is pinned by
  major in the CI workflows (`pnpm/action-setup` with `version: 10`), not in `package.json`. Packages created from
  this template choose their own policy.
- Leave `TODO` placeholders and the `scripts/init.mjs` rename logic intact; `init.mjs` must keep working for any
  new file that mentions the package name.

<!-- /template -->

## Files and encoding

- UTF-8 without BOM, LF line endings (CRLF only for `.bat` / `.cmd`), final newline, 2-space indentation —
  see `.editorconfig`, `.gitattributes` and `.oxfmtrc.json` (`endOfLine: "lf"`).
- Run `pnpm format` (oxfmt) before committing; `pnpm run check` must pass.

## Project

- TypeScript, ESM source, built with tsdown to ESM + CJS. Node.js ≥ 22, pnpm 10.
- Key commands: `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm format`, `pnpm run check`, `pnpm smoke`.
- Conventions (commits, versioning, releases): see [DEVELOPMENT.md](./DEVELOPMENT.md).
