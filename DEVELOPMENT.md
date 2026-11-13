# 开发与发布指南

> 本文件不会被发布到 npm（`files` 只包含 `dist/`），只给维护者看。

## 1. 用模板新建一个包

```bash
# 方式 A：GitHub 上点 "Use this template"（需在模板仓库 Settings 勾选 Template repository），然后 clone
git clone git@github.com:ropean/<new-repo>.git && cd <new-repo>

# 方式 B：不带模板的 git 历史直接拷一份
pnpm dlx degit ropean/npm-package-template <new-repo> && cd <new-repo> && git init
```

然后运行一次初始化脚本（改名、重置版本和 CHANGELOG、可选去掉 CLI，跑完会删掉自己）：

```bash
node scripts/init.mjs                     # 交互式，默认值取自目录名和 git remote
node scripts/init.mjs --name @ropean/foo --description "Does foo" --bin foo --yes
node scripts/init.mjs --name @ropean/foo --no-bin --yes   # 纯库，不要 CLI
```

```bash
pnpm install
pnpm run check
```

## 2. 目录结构

```
src/index.ts          库入口（公开 API，导出的函数要写明返回类型）
src/cli.ts            CLI 入口（可选；删掉它 + package.json 的 "bin" 就是纯库）
src/*.test.ts         vitest 单测（不会被打包）
tsdown.config.ts      构建：库 → ESM + CJS + .d.mts/.d.cts；CLI → ESM 单文件
scripts/check.mjs     一键检查：lint · typecheck · format · test · build · exports
scripts/smoke.mjs     打成 tarball → 装进临时项目 → 验证 import/require/类型/bin
scripts/release.mjs   幂等发版：检查 → 发布 → CHANGELOG → commit → tag → push
.github/workflows/    ci.yml（PR/推 main）· release.yml（推 v* tag 时发布）
```

## 3. 常用命令

| 命令                  | 作用                                                           |
| --------------------- | -------------------------------------------------------------- |
| `pnpm dev`            | tsdown watch 模式，改代码自动重新构建 `dist/`                  |
| `pnpm build`          | 构建一次                                                       |
| `pnpm test`           | 跑单测；`pnpm test:watch` 监听模式                             |
| `pnpm lint`           | oxlint                                                         |
| `pnpm typecheck`      | `tsc --noEmit`                                                 |
| `pnpm format`         | prettier 格式化全部文件                                        |
| `pnpm check:exports`  | publint + are-the-types-wrong，检查 `exports`/类型声明是否正确 |
| `pnpm check`          | 以上全部，逐项打印 PASS/FAIL（`--bail` 遇错即停）              |
| `pnpm smoke`          | 模拟真实安装的冒烟测试（`--keep` 保留临时项目方便排查）        |
| `pnpm pack:dry`       | 列出将被发布的文件清单                                         |
| `pnpm release <bump>` | 发版，见第 5 节                                                |

## 4. 本地测试（发布前在别的项目里用）

从“最快”到“最接近真实”：

### 4.1 单测

`pnpm test:watch`。

### 4.2 直接跑 CLI

```bash
pnpm build && node dist/cli.mjs --help
```

### 4.3 全局 link（CLI 最方便）

```bash
pnpm build
pnpm link:global          # = pnpm link --global，把 bin 注册到全局 PATH
my-cli --help             # 任意目录可用
pnpm dev                  # 开着 watch，改完代码全局命令立刻生效，无需重新 link
pnpm unlink:global        # 用完移除
```

### 4.4 在另一个项目里引用本地源码（库最方便）

```bash
# 在消费方项目里：
pnpm add link:../path/to/this-package   # 软链接，本包 `pnpm dev` 改动实时可见
# 或
pnpm add file:../path/to/this-package   # 拷贝一份（更接近真实安装，但改动后需重新 install）
```

注意：`link:` 是软链，消费方会解析到本包自己的 `node_modules`，偶尔会出现 React 之类的
"双实例" 问题；遇到时改用 4.5。用完记得把消费方的依赖改回正常版本号。

### 4.5 用 tarball 安装（最接近 npm 上的真实效果）

```bash
pnpm build && pnpm pack                       # 生成 ropean-xxx-0.1.0.tgz
cd ../consumer && pnpm add ../this-package/ropean-xxx-0.1.0.tgz
```

`pnpm smoke` 就是把这一步自动化了：打包 → 在临时目录 `npm install` →
分别用 `import()`、`require()`、TS (NodeNext) 消费，并执行每个 `bin --help`。
能抓到单测抓不到的问题：`files` 漏文件、`exports` 写错、bin 路径/shebang 不对、
运行时依赖误放到 devDependencies 等。**发版脚本会自动跑它。**

## 5. 发布到 npm

### 5.1 首次发布前一次性准备

1. `npm view <包名>` 返回 404 = 名字可用；scoped 包（`@ropean/xxx`）不会和别人冲突。
2. `npm login`，`npm whoami` 确认账号；建议账号开启 2FA（发布时会提示输入 OTP）。
3. `package.json` 填好 `description`、`keywords`；`README.md` 就是 npm 页面内容。
4. `pnpm pack:dry` 看一眼发布清单，只应包含 `dist/`、`README.md`、`LICENSE`、`package.json`。

### 5.2 本地发版（默认方式）

```bash
pnpm release patch        # 0.1.0 → 0.1.1
pnpm release minor        # 0.1.1 → 0.2.0
pnpm release major
pnpm release 1.0.0        # 指定版本
pnpm release:beta         # 0.2.0 → 0.2.1-beta.0，以 dist-tag "beta" 发布，不影响 latest
pnpm release prerelease --preid=rc
```

脚本流程：检查工作区干净 → 检查 npm 登录 → 改版本号 → `pnpm check` → `smoke` →
`publish --dry-run` 展示内容 → 确认 → 发布 → 按 conventional commits 生成 CHANGELOG →
commit `chore: release vX.Y.Z` → 打 tag → push 分支和 tag。

**任何一步失败都可以直接重跑同一条命令**：已发布的不会重发、已有的 commit/tag 不会重复，
版本号也不会被二次 bump（未完成的版本会被“续上”）。

常用参数：`--yes` 跳过确认、`--otp=123456` 直接传 2FA 码、`--tag=next` 指定 dist-tag、
`--no-smoke` 跳过冒烟测试。

### 5.3 CI 发版（可选，带 npm provenance 签名）

```bash
pnpm release patch --ci   # 只做 bump + CHANGELOG + commit + tag + push，不在本地 publish
```

推送 `v*` tag 会触发 `.github/workflows/release.yml`：校验 tag 与 `package.json` 版本一致 →
check → smoke → `npm publish --provenance` → 创建 GitHub Release（内容取自 CHANGELOG）。
如果该版本已在 npm 上（例如本地发过），会跳过 publish，只补 GitHub Release。

鉴权二选一：

- **Trusted Publishing（推荐，无需密钥）**：npmjs.com → 包 → Settings → Trusted Publisher →
  GitHub Actions，填仓库名和 `release.yml`。包必须先存在，所以**第一个版本请在本地发**。
- **Token**：npm 上创建 granular access token（勾选该包的 publish 权限），存到仓库 secret `NPM_TOKEN`。

### 5.4 发错了怎么办

```bash
npm deprecate @ropean/xxx@1.2.3 "broken, use 1.2.4"        # 推荐：标记废弃
npm dist-tag add @ropean/xxx@1.2.2 latest                   # 把 latest 指回旧版本
npm unpublish @ropean/xxx@1.2.3                             # 仅 72 小时内且无人依赖时可用；同版本号永远不能再用
```

修完后直接 `pnpm release patch` 发新版本。

## 6. 约定

- **Commit message** 用 conventional commits（`feat:`、`fix:`、`perf:`、`refactor:`、`docs:`、
  `chore:`，破坏性变更加 `!`，如 `feat!: drop node 20`），CHANGELOG 按此自动分组。
- **版本号**：`0.x` 阶段 minor 可以有破坏性变更；稳定后严格 semver。
- **依赖**：
  - `dependencies` —— 运行时需要，tsdown **不打包**它们（消费方安装时装）。
  - `peerDependencies` —— 由消费方提供（如 react、hono），同样不打包；可选的加 `peerDependenciesMeta`。
  - `devDependencies` —— 只在开发/构建时用；如果源码 import 了它，tsdown 会把它**打进** `dist`。
  - `.npmrc` 已设置 `save-exact=true`，新增依赖默认锁定精确版本。
- **Node 版本**：`engines.node` 为 `>=22`，构建 target 为 `node22`；要调整时三处一起改：
  `package.json` engines、`tsdown.config.ts` target、`ci.yml` matrix（以及 `@types/node` 主版本）。

## 7. 常见定制

- **只要 ESM**：`tsdown.config.ts` 库配置改 `format: ['esm']`；`package.json` 删 `main`、
  `exports["."].require`，`types` 改为 `./dist/index.d.mts`。
- **纯库，不要 CLI**：删 `src/cli.ts` 和 `package.json` 的 `bin`（构建配置会自动跳过）。
- **纯 CLI，不导出 API**：删 `exports`/`main`/`module`/`types`，`src/index.ts` 留作内部模块即可。
- **增加子路径导出**（如 `@ropean/xxx/utils`）：tsdown `entry` 加 `src/utils.ts`，`exports` 加：
  ```json
  "./utils": { "import": "./dist/utils.mjs", "require": "./dist/utils.cjs" }
  ```
  然后 `pnpm check:exports` 验证。
- **浏览器 / 边缘运行时**：把 `platform` 改为 `'neutral'` 或 `'browser'`，并避免使用 `node:*` 模块。
- **monorepo**：`release.mjs` 支持 `--dir=packages/core` 或根 `package.json` 中 `"release": { "dir": "packages/core" }`。
