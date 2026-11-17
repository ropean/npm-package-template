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
.github/workflows/    ci.yml（PR/推 main）· github-release.yml（GitHub Release + Packages）· publish-npm.yml（都在 Actions 里手动运行）
```

## 3. 常用命令

| 命令                  | 作用                                                           |
| --------------------- | -------------------------------------------------------------- |
| `pnpm dev`            | tsdown watch 模式，改代码自动重新构建 `dist/`                  |
| `pnpm build`          | 构建一次                                                       |
| `pnpm test`           | 跑单测；`pnpm test:watch` 监听模式                             |
| `pnpm lint`           | oxlint                                                         |
| `pnpm typecheck`      | `tsc --noEmit`                                                 |
| `pnpm format`         | oxfmt 格式化全部文件                                           |
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

新包初始版本是 `0.0.1`，**首次发布不带参数**，直接把 0.0.1 发出去：

```bash
pnpm release              # 首发 v0.0.1（也可改用 GitHub Actions，见 5.4）
```

之后每次发版：

```bash
pnpm release patch        # 0.1.0 → 0.1.1
pnpm release minor        # 0.1.1 → 0.2.0
pnpm release major
pnpm release 1.0.0        # 指定版本
pnpm release:beta         # 0.2.0 → 0.2.1-beta.0，以 dist-tag "beta" 发布，不影响 latest
pnpm release prerelease --preid=rc
```

脚本流程：预检 → 改版本号 → `pnpm check` → `smoke` → `publish --dry-run` 展示内容 → 确认 →
发布 → 按 conventional commits 生成 CHANGELOG → commit `chore: release vX.Y.Z` → 打 tag → push 分支和 tag。

常用参数：`--yes` 跳过确认、`--otp=123456` 直接传 2FA 码、`--tag=next` 指定 dist-tag、
`--no-smoke` 跳过冒烟测试、`--no-verify` 跳过 git hooks。

### 5.3 发布失败怎么办

**核心原则：publish 是唯一不可逆的一步。** 所以脚本把所有“可能在 publish 之后才失败”的条件
都挪到 publish **之前**检查；publish 之后如果还有失败，剩下的只是 git 记账，修好后重跑即可。

三个随时可用的命令：

```bash
pnpm release --status     # 查看当前版本走到哪一步：npm / CHANGELOG / commit / 本地 tag / 远端 tag
pnpm release              # 不带参数 = 从中断处继续（已发布的不重发，已有的 commit/tag 不重复）
pnpm release --abort      # 放弃一个【尚未发布】的版本：还原 package.json/CHANGELOG，删掉未发布的 tag
```

失败时脚本会打印：失败的步骤、原因、建议的下一步，以及**包是否已经在 npm 上**。

#### 发布之前失败（没有任何不可逆操作）

| 场景                                     | 脚本行为 / 你要做的                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| 工作区有未提交改动                       | 预检拒绝。提交或 stash 后重跑                                                       |
| 本地落后于远端分支                       | 预检拒绝（否则发布后 push 会被拒）。`git pull --rebase` 后重跑                      |
| 没有推送权限 / git 凭据失效 / 连不上远端 | 预检用 `git push --dry-run` 和 `git fetch` 提前发现                                 |
| 未配置 git user.name / email             | 预检拒绝（否则发布后 commit 会失败）                                                |
| npm 未登录 / token 过期                  | 预检 `npm whoami` 拒绝。`npm login` 后重跑                                          |
| registry 连不上（断网、代理、npm 故障）  | 预检 `npm ping` 拒绝；查询 npm 状态失败时**直接报错**，不会误判为“未发布”而重复发布 |
| 全局配置了镜像（如 npmmirror）           | 所有 npm 查询和发布都显式指定 `publishConfig.registry`，不受全局镜像影响            |
| 版本参数写错（`pnpm release pathc`）     | `npm version` 报错，版本号不变                                                      |
| lint / 类型 / 测试 / 构建 / exports 失败 | 版本号已改但未提交。修代码、提交修复后无参数重跑；或 `--abort` 放弃这个版本号       |
| 冒烟测试失败（漏文件、bin 坏了等）       | 同上                                                                                |
| 确认提示时选了 n / 按了 Ctrl+C           | 显示“Interrupted during: …”，重跑续上或 `--abort`                                   |
| 远端已有同名 tag，但 npm 上没有这个版本  | 拒绝发布（可能是 CI 正在发 / 发失败了 / 别人的发布）。看 `--status`，见 5.4         |

#### publish 本身失败

脚本会识别 npm 的错误类型分别处理：

| npm 报错                                   | 处理                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 需要 2FA 验证码（EOTP）                    | 终端里直接提示输入 OTP 并重试；非交互环境提示用 `--otp=` 重跑                                                          |
| 超时 / 连接重置 / 429 限流 / 5xx           | **先查 npm 上是否其实已经发成功了**（请求可能已到达），没有才指数退避重试，最多 4 次                                   |
| “cannot publish over previously published” | 等待 CDN 同步后再查一次：查到了 = 视为成功；查不到 = 这个版本号以前被 unpublish 过，永远不能再用，`--abort` 后换版本号 |
| E401 / 登录失效                            | 提示 `npm login` 后重跑                                                                                                |
| E403 无权限                                | 提示常见原因：不是该包/组织的维护者、账号要求 2FA 而 token 不支持、版本号曾被 unpublish                                |
| E404 scope 不存在                          | 提示 scope 要用你自己的 npm 用户名或组织名                                                                             |
| E402 / 包名与已有包太相似 / 包太大         | 分别给出对应提示                                                                                                       |

#### 发布之后失败（包已经在 npm 上）

脚本会醒目提示 **`IS ALREADY ON NPM … Do not bump again`**。此时**不要**再 bump 版本，修好问题后
`pnpm release`（不带参数）即可：会跳过 publish，只补 CHANGELOG / commit / tag / push。

| 场景                                            | 处理                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| git commit 被 hook 拒绝（husky、commit-msg 等） | 修 hook 问题，或 `pnpm release --no-verify`                                      |
| push 被拒：别人刚推了新提交                     | `git pull --rebase` 后 `pnpm release`；tag 会自动指向 rebase 后的 release commit |
| push 被拒：分支受保护（GH006）                  | `pnpm release --tag-only` 只推 tag，release commit 走 PR 合并                    |
| 远端 tag 指向别的提交                           | 默认**绝不强推覆盖**，提示你检查；确认自己的才是对的再用 `--force-tag`           |
| 发布后 `npm view` 暂时查不到                    | 正常的 CDN 延迟，脚本会轮询等待；查不到也不影响后续步骤                          |
| `--abort` 一个已发布的版本                      | 拒绝，并提示用 `npm deprecate` / `npm dist-tag` 补救（见 5.5）                   |

#### 其它

- **放弃一个已推送 release commit 的版本**：`--abort` 不会改写已推送的历史，只删除未发布的 tag；
  下次用 `pnpm release patch --force-bump` 跳过这个版本号。
- **两个人同时发同一个版本**：后发的人会在“远端已有 tag”或“npm 已存在该版本”处停下，不会覆盖。

### 5.4 通过 GitHub Actions 发版（无需本地命令）

有两个相互独立的渠道，各是一个 workflow，都在 GitHub → Actions → 选择 workflow → **Run workflow** 里手动运行。

| Workflow             | 输入                                             | 作用                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `github-release.yml` | `version`：`patch\|minor\|major\|x.y.z\|current` | Job 1：改 `package.json` 版本、更新 CHANGELOG、提交、打 tag、推送、打包并创建 GitHub Release（`<包名>.tgz` + 带版本号的 `.tgz`）。Job 2：把该 tag 发布到 GitHub Packages。在默认分支上运行 |
| `publish-npm.yml`    | `tag`：已存在的 tag，如 `v0.0.1`                 | 带 provenance 把该 tag 发布到 npm；该版本已在 npm 上则跳过                                                                                                                                 |

本地不再需要 `git tag` 或 `pnpm release --ci`：运行 **GitHub Release**，tag、Release 和 GitHub Packages 发布都在这一次运行里完成。
（由 Actions 创建的 tag 不会触发其它 workflow，这是 GitHub 对 `GITHUB_TOKEN` 的规则，所以 GitHub Packages 是同一个 workflow 的第二个 job，而不是单独的 workflow。）

说明：

- 首次发版（还没有任何 tag）会按 `package.json` 当前版本发布，不管 `version` 填什么。
- `version = current` 发布 `package.json` 里已有的版本：tag 不存在就先创建（第一次发版请用它），已存在则只重新做 Release 和 GitHub Packages 发布。
- 发布提交由 `github-actions[bot]` 推送到默认分支；如果该分支开了分支保护，需要允许这次推送。
- GitHub Packages 用内置的 `GITHUB_TOKEN`（无需 secret），包的 scope 必须等于仓库 owner（如 `@ropean` ↔ `github.com/ropean`）。
  从它安装需要带 `read:packages` 权限的 GitHub token，即使是公开包。
- 使用者可通过 `npm i -g https://github.com/<owner>/<repo>/releases/latest/download/<包名>.tgz` 从 Release 安装（`<包名>` 是去掉 scope 的名字）。
- npm 鉴权（`publish-npm.yml` 用），二选一：**Trusted Publishing**（npmjs.com → 包 → Settings → Trusted Publisher →
  GitHub Actions，填仓库名和 `publish-npm.yml`；包必须先存在，所以**第一个版本请在本地发**）或把 granular token 存为仓库 secret `NPM_TOKEN`。
- 失败的 job 直接 Re-run 即可（已存在的版本会被跳过）。
- 代码问题导致 tag 已推送但未发布时，提交修复后运行 `pnpm release --ci --retag`，把**未发布**的 tag 移到新 HEAD 并重新推送；
  不想要这个版本了用 `pnpm release --abort`（会删除远端未发布的 tag）。

### 5.5 发错了怎么办（已经发布的版本有问题）

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
