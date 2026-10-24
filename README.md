# DSH Plugin Meta

`dsh-plugin-meta` 定时刷新 `dsh-plugin-insight` 已核实 npm 包的下载量和发布信息。

## 数据

输入文件 `data/PACKAGE-MANIFEST.jsonl` 每行保存一个 npm 包名，按 `package` 字节序去重并排序：

```jsonl
{"package":"@example/dsh-plugin"}
{"package":"dsh-example"}
```

输出文件 `data/META.jsonl` 每行保存一个包的最近一次检查结果，同样按 `package` 字节序排序：

```text
{"package":"@example/dsh-plugin","checked_at":"2026-10-24T08:00:00.000Z","window_start":"2026-09-24","window_end":"2026-10-23","downloads_30d":123,"first_published_at":"2026-01-02T03:04:05.000Z","latest_version":"1.2.3","latest_published_at":"2026-10-20T03:04:05.000Z"}
```

值未知时省略对应字段，不输出 `null`；真实零下载量使用数字 `0`。成功记录省略 `error`，失败记录保留结构化 `error`。生产和消费脚本直接校验必要字段，不维护独立 JSON Schema。

只有下载量和包元数据均成功获取时才更新 `checked_at`。失败时保留上一次成功数据，并把本次错误记录在 `error`；从未成功的包只保存 `package` 和 `error`，供下一次增量刷新继续重试。

## 刷新

```bash
# 默认：刷新超过 24 小时未检查的数据，最多 2000 个包
npm run refresh:meta

# 忽略检查时间，最多刷新 2000 个包
npm run refresh:meta -- --full

# 刷新全部包
npm run refresh:meta -- --full --max-count all
```

刷新器使用 npm registry 与 npm downloads API，按最近 30 个完整 UTC 日统计下载量。registry 核验成功后才查询下载量，下载请求按固定间隔启动并对限流做有限退避。默认数量、时间阈值、并发数、下载请求间隔、超时和重试次数保存在 `package.json#config`。

## 开发

```bash
npm install
npm run check
```

项目使用 Node.js 24.19.0、原生 ESM 和 `.mjs` 脚本，采用 [CC0 1.0 Universal](LICENSE)。
