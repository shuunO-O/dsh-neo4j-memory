# 事件检索与紧凑证据

`memory_database_search` 使用同一个入口，支持 `search`、`read`、`expand`、`nearby`。

## 初始检索与重排

```json
{"query_text":"Neo4j 的部署方式和方案演进"}
```

有问题向量时，分别从事件摘要和原文分块召回最多40个不同事件。原文路线取各事件中相似度最高的分块；候选在实体、写入日期和已交付ID过滤之后选取。两路排名通过RRF融合（k=60），再加问题词覆盖分，最后进行原文完全相同的事件去重与MMR多样性选择（lambda=0.75）。默认交付前8个事件的摘要与摘录，并附最多24个后续候选的`id | 摘要`索引；索引候选不占摘录预算，可用`read event_id=<id>`读取原文，也不进入追查游标。

证据行在`id`后附带紧凑的来源标签：全文行是`[第53章 魔网]`（章节标题只出现在全文行），索引行只给`[第53章]`。事件没有章节元数据时不加标签。模型可见字段由`AGENT_EVENT_FIELDS`固定为`id / summary / quote / read / via / time / chapter / title`；`embedding*`、`raw_session`、`concept_alignment`、`source_scenes`、`EventSource.hash`等内部字段不会进入模型可见文本。

`search`还接受`chapter`作为事件级精确范围，与`time_hint`同级：只匹配`Event.chapter`，可与`query_text`/`entity_filter`/`time_hint`组合，不能用于Person/Concept。这样“第81章”是一个明确条件，而不是把章号塞进向量。

没有问题向量的纯实体/日期检索按写入时间排序。

当前在数据库中计算精确余弦、排序后只取每路40候选，支持筛选和排除已交付事件后补足候选；计算量随库中事件和原文分块数量增长。重排在本地完成，不调用额外的重排或规划模型。这些分数都是检索启发式，不是事实置信度。

另有一个**默认关闭**的实验性词面召回：设置 `DSH_NEO4J_MEMORY_FULLTEXT=1` 时，会为 `Event.summary` 建立 `cjk` 全文索引，并作为第三路参与 RRF。实测它只在查询本身包含答案关键词时才有效（例如“分发食物 建立信任”能把对应事件排到第1），泛化提问下会挤掉更好的向量结果（q13 的关键事件交付从 8/17 降到 4/17），因此默认不启用。

## 原文向量与旧库升级

新保存的记忆保留完整Event.content，并按800个Unicode码点、相邻120个码点重叠生成内部EventSource分块。摘要、实体名称和原文分块通过同一个默认embedding模型向量化，原文分块与事件在同一事务写入。

旧库中没有原文分块的事件仍可通过摘要检索，命中时会提示尚未补齐。可在设置中执行“重新向量化”，为已有记忆生成分块向量。重新向量化先计算所有向量，之后在事务中更新向量、内部来源分块及模型元数据；embedding请求失败不会替换旧向量。模型或维度改变仍需重新向量化。

800/120是面向一般记忆文本的正式分块规则；实验小说的原文场景分块并不等同于此规则。因此实验分数不能直接视为此正式版本在所有记忆上的质量保证。

## 证据交付与去重

结果包含原摘要与原文精确摘录。原文向量路线保留该事件中最高相似度分块的位置，摘录优先在命中分块内选择，各事件共享每次1000字符的摘录预算；没有有效命中分块时沿用最多120字符的关键词摘录，初始来源窗口为前32000字符。每个有原文的事件只给一个`read event_id=<id> limit=<原文长度>`参数（超过10000字符时分段），不再逐条重复工具用法；`read`的语义定位（`query_text`+`top_k`）写在工具说明里。范围按Unicode码点计，起点包含、终点不包含。短摘录未提及不等于全文不存在；摘要仍需原文核实。共享概念和来源相邻不证明因果或发生顺序。

同一会话在15分钟的证据历史有效期内，普通搜索、扩展和邻近补读都排除已经成功交付的事件ID；同一会话的调用串行提交，失败不占用交付记录。每会话最多保留640个ID及640段摘录，最多32个会话。历史被淘汰后，较早事件可再次参与检索。

完全重复的摘录用`quoteRef: {id, range}`引用本会话此前成功交付的原文，渲染为“原文同…”。read始终可读取完整原文。

独立新问题需要重新检索前面已经出现过的事件时，可显式重置当前会话的去重记录与旧游标：

```json
{"query_text":"另一个需要重新核对的问题","reset_seen":true}
```

reset_seen仅用于search。不同会话的记录互不影响。空结果不证明记忆不存在，尤其在已交付ID被排除时。

## 阅读与追查

```json
{"operation":"read","event_id":"event_12","start":0,"limit":1600}
```

read无需cursor或模型Key，limit为1–10000字符，返回原文、范围、总长度与可选next偏移，不占新事件名额。

同一会话已交付`event_12`后，`event_id:"12"`可解析到该事件；未交付或其他会话的数字简写会明确要求使用完整ID，不猜测全库事件。完整ID保持原有读取行为。读取文本会显示全文长度与当前范围，尚有后文时给出包含完整ID、start和limit的续读参数。

```json
{"operation":"expand","cursor":"上次返回的cursor","concept_id":"concept_3","limit":3}
```

沿`Event → MENTIONS → Concept（含同等价组成员）← MENTIONS ← Event`找候选，保留原查询与筛选条件；有原问题向量时使用相同混合重排。组内多个Concept关联同一Event时只计一次；共享概念、全库关联事件数和继续入口也按组去重。实体名筛选命中任一组成员后覆盖组内所有成员的事件。只允许当前游标提供的Concept入口，不调用新的embedding或规划模型。limit兼容1–8，但实际新增上限为4且不超过追查链剩余额度。移出概念组后需要重新搜索获取游标。

```json
{"operation":"nearby","cursor":"上次返回的cursor","event_id":"event_ch33_e06","before":2,"after":2}
```

nearby按可靠的`*_ch章节_e记录号`定位同章相邻记录；普通event_123不具备这种位置，使用read。before/after为0–10，默认2，每次最多新增4个事件。相邻记录保持编号顺序。

每条追查链最多20个事件，每次按剩余名额交付，不因不足一整批而拒绝；游标与概念入口只从实际交付的节点生成。没有为某种操作硬预留名额，也没有强制“先补读再搜索”的流程。旧游标可在有效期内分支使用，但已交付事件会话级去重仍生效。

游标有效期15分钟，最多32个状态，向量模型/维度改变及数据记录删除或ID重复会中断追查。Person/Concept定向检索保留原结果结构，不纳入Event去重历史。

## 开发检查

```powershell
npm run build
npm test
npm run selfcheck
$env:DSH_NEO4J_MEMORY_INTEGRATION='1'
node --test --test-concurrency=1 tests/evidence-integration.test.mjs tests/integration.test.mjs
```

集成测试使用隔离数据库及本地模拟模型服务。
# Event 内的语义读取

`read` 可以传 `event_id` 和 `query_text`，只在该 Event 已有的原文分块向量中召回最多 12 个不同文本块，默认选择前 4 块（`top_k` 为 1..4），返回完整文本和 Unicode 字符位置，并合并选中块的重叠范围。同一个 Event 可以多次换问题检索，不受全局搜索的已交付 Event 去重影响。省略 `query_text` 时保留原来的 `start`/`limit` 阅读；两种模式不可混用。

设置 `DSH_NEO4J_MEMORY_SOURCE_RERANK_URL` 为阿里云兼容重排完整端点（如 `https://dashscope.aliyuncs.com/compatible-api/v1/reranks`），即可对这些候选块进行云端重排；模型变量 `DSH_NEO4J_MEMORY_SOURCE_RERANK_MODEL` 默认 `qwen3-rerank`，密钥 `DSH_NEO4J_MEMORY_SOURCE_RERANK_API_KEY` 未设置时复用 embedding key。未配置端点时按向量分数排序。原文不重新抽取或向量化；每次语义 read 会产生问题 embedding 费用，启用重排时另有重排费用。

可选 `min_score` 按当前排序模型的相关性分数过滤，再取前 K；不默认设未经校准的阈值。返回 `ranking`、向量分数和最终分数以供检查。相关性分数不是置信概率；没有达标片段不等于原文不存在答案。缺少兼容的原文向量会明确报错，可重新向量化补齐，不会默默退回原文开头。

