# DSH Plugin Meta

`dsh-plugin-meta` 分开采集 DSH 插件的 npm 包指标和 GitHub 仓库指标，为 `dsh-plugin-insight` 提供可固定版本的缓存。

## 数据与身份

| 数据   | 采集清单                  | 指标快照              | 主键与排序                |
| ------ | ------------------------- | --------------------- | ------------------------- |
| npm    | `data/NPM-MANIFEST.jsonl` | `data/NPM-META.jsonl` | `package`，包名字节序     |
| GitHub | `data/GIT-MANIFEST.jsonl` | `data/GIT-META.jsonl` | `repository_id`，数字升序 |

每个文件均为 JSONL。npm 清单每行只保存一个精确包名：

```jsonl
{
  "package": "@example/dsh-plugin"
}
```

GitHub 清单以 API 核实的数字仓库 ID 去重，保存 GraphQL node ID、当前仓库名称、来源地址和已知 npm 包名：

```jsonl
{
  "repository_id": 123,
  "node_id": "R_example",
  "repository": "example/plugins",
  "npm_packages": [
    "@example/a",
    "@example/b"
  ],
  "source_repositories": [
    "example/plugins"
  ]
}
```

`repository_id` 是 GitHub 身份主键；`node_id` 用于批量请求同一个对象，避免改名后按旧名称误采同名新仓库。`repository` 是可变的定位和展示字段，最新名称以指标成功响应为准。`source_repositories` 保存小写的来源仓库地址，合并同一仓库的大小写变体、组件子目录和重定向。清单及关联采用追加合并，普通同步不删除历史仓库或已知包名。

`npm_packages` 是关联数组，一个仓库可关联多个包，空数组表示上游没有提供已知包名。它不是发布物所有权的独立证明，不因同名猜测关联。npm 指标仍按完整包名独立保存，允许有包却没有已知仓库；多个组件共享仓库或包时不重复解释热度。

npm 指标记录最近 30 个完整 UTC 日的下载量、首次发布时间、latest 版本及其发布时间：

```text
{"package":"@example/dsh-plugin","checked_at":"2026-10-24T08:00:00.000Z","window_start":"2026-09-24","window_end":"2026-10-23","downloads_30d":123,"first_published_at":"2026-01-02T03:04:05.000Z","latest_version":"1.2.3","latest_published_at":"2026-10-20T03:04:05.000Z"}
```

GitHub 指标单独保存 Star、归档状态和成功采集时间，不重复保存 npm 下载量或关联：

```jsonl
{
  "repository_id": 123,
  "repository": "example/plugins",
  "stars": 42,
  "archived": false,
  "checked_at": "2026-10-24T08:00:00.000Z"
}
```

未知指标省略，真实零使用数字 `0`；不输出 `null`。npm 失败记录包含结构化 `error`；只有下载量和包元数据均成功才更新顶层 `checked_at`，失败保留旧成功值。GitHub 失败保存在 `GIT-ERRORS.jsonl`，按仓库 ID 排序；旧 Star 和成功时间保持不变。无法核实 ID 的来源地址保存在 `GIT-PENDING.jsonl`，按仓库地址排序并保留已知包名及具体状态，后续导入重试；`NOT_FOUND_OR_INACCESSIBLE` 不表示已经证明仓库被删除。

## 导入与刷新

```bash
# npm 清单导入不需要 GitHub token，只写 NPM-MANIFEST.jsonl
npm run import:npm

# Git 清单导入核实仓库身份并采集初始 Star，只写 GIT-* 文件
GH_TOKEN=... npm run import:git

# 使用已保存的同格式目录，不重复获取来源
GH_TOKEN=... npm run import:git -- --source /path/to/plugins.json

# 分别增量刷新：默认只刷新超过 24 小时未尝试的数据，最多 2000 个对象
npm run refresh:npm
GH_TOKEN=... npm run refresh:git

# 忽略新鲜度，刷新全部对象
npm run refresh:npm -- --full --max-count all
GH_TOKEN=... npm run refresh:git -- --full --max-count all
```

标准路径、来源 URL、默认数量、过期阈值、批量大小、超时和重试次数集中维护在 `package.json#config`。`refresh:meta` 保留为 npm 刷新的兼容命令。GitHub 使用 `GH_TOKEN` 或 `GITHUB_TOKEN`，只读取仓库身份与指标，不运行目标插件代码。

GitHub 使用有界批量 GraphQL 请求，逐批保存进度；只请求精确清单项，不使用存在搜索数量上限的仓库搜索。单项失败不丢弃同批成功项；请求整体失败时保存本批错误并退出，保留未处理项供下次继续。npm 导入脚本独立将上游已知包名追加合并到 `NPM-MANIFEST.jsonl`，不删除既有包名；Git 导入仅保存仓库及 `npm_packages` 关联，不写 npm 文件。导入恢复时复用已核实的来源地址，只解析新增和待解析项。刷新按最近成功时间和失败尝试时间中较新的一个判断 24 小时新鲜度，默认最多 2000 个仓库；仓库名称改变时仍通过 node ID 查询并检查数字 ID 不变。

GitHub Actions 拆分为两个独立工作流，均支持手动触发，每 3 小时运行一次：

| 工作流                              | 定时（UTC）           | 导入与刷新入口              | 检查        | 提交范围 |
| ----------------------------------- | --------------------- | --------------------------- | ----------- | -------- |
| `.github/workflows/refresh-npm.yml` | 每 3 小时的第 17 分钟 | `import:npm`、`refresh:npm` | `check:npm` | `NPM-*`  |
| `.github/workflows/refresh-git.yml` | 每 3 小时的第 47 分钟 | `import:git`、`refresh:git` | `check:git` | `GIT-*`  |

npm 更新使用 `scripts/refresh-npm.mjs`，GitHub 更新使用 `scripts/refresh-git.mjs`；共享参数与新鲜度选择逻辑位于 `scripts/refresh-options.mjs`，不互相导入采集器。各工作流只检查和更新自己的数据，不依赖另一工作流的成功状态；整体请求失败时保存已有进度，并由所属工作流报告失败。它们使用同一个并发组串行发布，避免向同一分支同时推送；采集步骤、定时配置与失败状态仍分别维护。

Git 工作流在 `check:git` 前执行 `prune:git`，清理已从检出的清单移除的仓库所对应的指标和错误记录。

只有 Git 工作流向采集步骤提供内置 `github.token`；非公开仓库可能无法访问，必须保留待解析或失败记录，不假定 token 有组织访问权限。
工作流只有提交并进入默认分支后才会按计划执行。消费者应固定完整 commit SHA 或内容摘要，在同次运行中读取同一个版本。

手动确认失效仓库并从 `GIT-MANIFEST.jsonl` 删除身份后，必须在同次变更中运行：

```bash
npm run prune:git
npm run check
```

`prune:git` 以当前清单为准，同步移除不再关联清单的 `GIT-META.jsonl` 指标和 `GIT-ERRORS.jsonl` 错误记录，保留其余记录及原有时间。它不访问网络、不修改清单或待解析地址，不依据访问失败自动判定仓库失效。清单与关联记录应一起交付；校验仍拒绝孤立记录。

## 开发

```bash
npm ci
npm run check
```

校验包括格式、离线确定性测试和 GitHub 数据身份及结构检查；实时来源采集独立报告，不由离线测试替代。项目使用 Node.js 24.19.0、原生 ESM 和 `.mjs` 脚本，采用 [CC0 1.0 Universal](LICENSE)。
