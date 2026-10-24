# dsh-neo4j-memory

给 DeepSeek Harness（DSH）用的长期图记忆插件。

只向模型提供两个工具：

- `memory_database_save(content)`：提取事件、人物、概念、地点和关系，写入 Neo4j。
- `memory_database_search(query_text?, target_label?, entity_filter?, time_hint?)`：按语义、实体或日期召回，返回主匹配及一跳关系。

记忆按“事件 + 实体 + 关系”组织，不是聊天记录切片。只有显式调用保存工具的内容才会被写入；插件不扫描聊天记录。

> 说明：这是一个纯 vibe coding 项目，使用 `GPT6.1-Sol` 与 `deepseek-v4.1-flash-1017` 完成。功能和主要链路在真实环境里跑过；请把它当成一个可读、可改的开源原型，而不是生产级产品。

## 特性

- 四类节点：`Event`、`Person`、`Concept`、`Location`；四类关系：`PARTICIPATED_IN`、`OCCURRED_AT`、`MENTIONS`、`HAS_ATTITUDE`
- 首次调用自动下载本地 Neo4j 5.26.30 + Temurin JRE 21（约 211 MB），无需系统 Java；也可连外部 Neo4j
- 设置页：三组模型 Key 与端点、概念对齐开关与阈值、向量维度、重新向量化
- 只读图谱页：查看实际写入的节点、关系和属性
- 写入是一个 Neo4j 事务，失败回滚
- Key、端点、模型、阈值、维度保存后下一次调用生效
- 节点 ID 按类型自增：`event_1`、`person_2`、`concept_3`……

## 要求

- Windows 10/11 x64
- DSH `>=0.2.1-rc.2 <0.3.0`
- Node.js 22+（桌面宿主内置）
- 提取与向量 API Key；概念对齐 Key 可选

## 安装

桌面版插件页（推荐）：

1. 打开 **插件 → 添加插件**。
2. 输入 `dsh-neo4j-memory`，按提示安装。
3. 安装完成后重启 DSH（或按插件页提示重载），在 **设置 → Neo4j 记忆** 配置 Key。

命令行安装（PowerShell；路径按你的实际安装位置调整）：

```powershell
$cli = "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $cli plugin --profile desktop add dsh-neo4j-memory
```

也可以直接从 GitHub 安装：

```powershell
$cli = "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $cli plugin --profile desktop add github:shuunO-O/dsh-neo4j-memory
```

`--profile desktop` 是桌面版默认 profile；如果你用的是其他 profile，换成对应名称。

## 配置

安装并启用后打开 **设置 → Neo4j 记忆**：

- **API Key**（默认折叠）：提取、向量、概念对齐三组
- **模型端点与阈值**（默认折叠）：三组 Base URL 与模型名、概念对齐阈值（80%–99%）
- **向量维度**：默认 1024，必须与向量模型实际输出一致；修改后点「重新向量化」
- **数据库**：本地/外部模式、外部 Neo4j 密码、本地数据目录

| 用途 | 默认服务 / 模型 |
|---|---|
| 提取 | DeepSeek / `deepseek-flash` |
| 向量 | DashScope / `qwen3.7-text-embedding`，1024 维 |
| 概念对齐 | TypeSafe / `jev`，阈值 0.95 |

概念对齐填的是**完整 endpoint**：TypeSafe 为 `https://api.typesafe.ai/v1/systemone`，OpenRouter 为 `https://openrouter.ai/api/alpha/decisions`。用 OpenRouter 时模型可填 `typesafe/jev-1.13` 或 `typesafe/jev-1.14`；换模型后建议重新校准阈值。

保存后，Key、端点、模型、阈值、维度在下一次调用时生效；本地数据目录、Neo4j 模式、外部密码需要重启 DSH。Key 保存在当前 profile 配置中，不回显，也不进入对话。

### 向量维度与重新向量化

不同模型或不同维度的向量不能比较，Neo4j 的向量索引也固定维度。插件把当前模型与维度记录在 `MemoryMeta` 节点里；配置变化后，保存和语义搜索会被拒绝，直到重新向量化。

设置页「向量索引」区域会显示当前库的模型、维度、节点数，并提供「重新向量化」按钮。操作会重算所有记忆节点的向量、重建四个向量索引；新向量先暂存，全部计算成功后才替换旧向量并更新元数据。

### 本地 Neo4j

默认 `DSH_NEO4J_MEMORY_NEO4J_MODE=auto`：没有配置外部 URI/密码时使用本地实例，首次调用工具时下载并启动。数据、日志、`state.json` 位于 `%LOCALAPPDATA%\dsh-neo4j-memory\`，可在设置页改到其他可写目录（需重启）。

同一时间只建议运行一个使用托管模式的 DSH 实例。想让本地实例在 DSH 退出后继续运行，设置 `DSH_NEO4J_MEMORY_NEO4J_KEEP_RUNNING=1`。

排障日志：

- `%LOCALAPPDATA%\dsh-neo4j-memory\provision.log`
- `%LOCALAPPDATA%\dsh-neo4j-memory\logs\console.log`

Neo4j Community 采用 GPLv3，Temurin JRE 采用 GPLv2+CE；插件不随包分发这些二进制，首次运行时从官方地址下载。

## 环境变量（可选）

插件配置优先于环境变量。

| 变量 | 默认值 |
|---|---|
| `DEEPSEEK_API_KEY` / `EMBEDDING_API_KEY` / `TYPESAFE_API_KEY` | 无；提取、向量、对齐 Key |
| `DSH_NEO4J_MEMORY_NEO4J_MODE` | `auto`（`auto` / `managed` / `external`） |
| `DSH_NEO4J_MEMORY_NEO4J_URI` | `bolt://localhost:7687`（external） |
| `NEO4J_PASSWORD` | 无；external 必填 |
| `DSH_NEO4J_MEMORY_RUNTIME_DIR` | `%LOCALAPPDATA%\dsh-neo4j-memory` |
| `DSH_NEO4J_MEMORY_EXTRACTION_URL` / `_MODEL` | `https://api.deepseek.com` / `deepseek-flash` |
| `DSH_NEO4J_MEMORY_EMBEDDING_URL` / `_MODEL` | DashScope compatible / `qwen3.7-text-embedding` |
| `DSH_NEO4J_MEMORY_EMBEDDING_DIMENSIONS` | `1024` |
| `DSH_NEO4J_MEMORY_ALIGNMENT_URL` / `_MODEL` | `https://api.typesafe.ai/v1/systemone` / `jev` |
| `DSH_NEO4J_MEMORY_ALIGNMENT_THRESHOLD` | `0.95`（0.80–0.99） |
| `DSH_NEO4J_MEMORY_CONCEPT_ALIGNMENT` | `true`；设为 `0`/`false` 关闭 |
| `DSH_NEO4J_MEMORY_TIMEZONE` | `Asia/Shanghai` |

外部 Neo4j 需支持向量索引与 `vector.similarity.cosine`（如 Neo4j 5.23+）。

## 工作方式

```text
保存：content
  → 提取事件/实体/关系
  → 生成事件摘要与实体名向量
  → 概念对齐（可选）
  → 一个 Neo4j 事务写入

检索：query / entity / date
  → 向量 top-3，或按实体/日期过滤
  → 取最相关节点的一跳邻居
  → 返回主匹配 + 次要匹配 + 上下文
```

图谱页：**设置 → Neo4j 记忆 → 展开图谱**，或访问 `/dsh-neo4j-memory/graph/`。只读，不写回 Neo4j；导出 JSON 只影响浏览器视图。

## 当前限制

- 提取与合并较粗：仅单次抽取；概念按名称/别名 + 向量 + 两两判同，不保证一定准确。
- 检索较粗：向量 top-3 + 一跳。
- 图谱只读：没有删除、合并、编辑节点/关系的 UI。
- `0.6.0`，没有 benchmark，只在几十条记忆的规模上验证过；仅在 Windows x64 上测试过。

## 开发

```powershell
npm ci --legacy-peer-deps
npm run build
node selfcheck.mjs
node tests/backend.test.mjs
npm pack
```

- `src/` 是 TypeScript 源码，`lib/` 是编译产物，`assets/` 是提取提示词，`web/graph/` 是图谱页面。
- `npm test` 使用 `node --test`；`DSH_NEO4J_MEMORY_INTEGRATION=1 node tests/integration.test.mjs` 可跑真实 Neo4j 集成测试。
- `npm publish` 会先执行 `prepublishOnly`：构建 + selfcheck + 后端测试；`npm pack` 会先构建。

## 隐私

- 记忆库在本机，但提取/向量/对齐会把内容发给你配置的模型 API。
- API Key 存在当前 DSH profile 的配置里，不进入对话或模型上下文。
- 不要把密码、密钥或不想发给模型服务的内容存进记忆库。

## 许可证

MIT，见 [LICENSE](LICENSE)。
