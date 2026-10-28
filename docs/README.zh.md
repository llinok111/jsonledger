# jsonledger 中文速览

> jsonrepair 给你"修好的文档"，jsonledger 告诉你"这次修复对数据做了什么"。

基于 [jsonrepair](https://github.com/josdejong/jsonrepair) 3.15.0（ISC）的派生项目。
**修复引擎一个字都没改**（`npm run exactness:check` 会校验 46 个上游文件哈希），
新增的是一层审计：定位缺陷、逐条记账、给损失分级、给裁决。

## 它解决什么

jsonrepair 的公开接口只有"返回字符串"或"抛异常"。于是这四件事对调用方完全不可见：

| 输入 | jsonrepair | jsonledger |
|---|---|---|
| `{"a":NaN}` | 返回 `{"a":"NaN"}` | `coerced` @ `$.a`，`data` |
| `[{"id":1},{"id":` | 返回 `[{…},{"id":null}]`（凭空造出一条记录） | `fabricated` @ `$[1].id`，`data` |
| `{"a":1, ...}` | 删掉 `...` | `elided`，`warn` |
| `[1,2,,3]` | 改成 `[[1,2],3]`（结构被改） | `restructured`，`data` |
| `{"a":1`（截断） | 补齐右括号 | `truncated`，`warn` |

## 实测（可复现）

```console
npm run build
node tools/bench/run.mjs node_modules --limit 600 --json docs/bench-600.json
```

600 篇真实 JSON × 9 类已知真值的破坏：

- 无损破坏 **3596** 例 → 误报 **0**
- 有损破坏 **2236** 例 → 检出 **2236**（100%）
- 其中有损输入里，上游仍然"正常返回"了 **1798** 篇；这 1798 篇里有 **1204 篇**语义已经变了，而返回值里没有任何提示
- 合法 JSON 原样返回：双方均 600/600
- 单篇中位耗时（warm、同进程）：0.029 ms → 0.086 ms

## 用法

```js
import { repair, diagnose, verify } from 'jsonledger/ledger'

const r = repair('{"a":NaN,"b":1,}')
r.verdict // 'reject'
r.loss    // 'data'
r.ledger  // 逐条：coerced/$.a …

const safe = repair(text, { policy: 'safe' })
safe.output === null // 有损就不给你产物

diagnose('{a:1,}')          // 只体检，不修
verify(原文, 别人修好的文本)  // 审计别人的修复
```

```console
jsonledger check  <file...>   # 只诊断
jsonledger repair <file>      # 修复 + 账本 + 文档
jsonledger explain <file>     # 修复 + 只打账本
```

退出码即契约：`0` 干净 · `1` 无损修复 · `2` 需复核 · `3` 有损（默认不输出文档）· `4` 修不了 · `5` 用法错误。

## 损失分级

`none` < `cosmetic`（只改引号逗号）< `type`（类型变了）< `truncated`（截断/省略号，后面是什么不知道）< `data`（凭空造、丢值、破坏性改类型、改嵌套）

## 已知边界

1. 只报"改了什么"，不知道"你本来想要什么"。
2. 对齐是值级的：完全不含标量的空容器（`{}` / `[]`）只能靠容器计数兜底。
3. 成员换序不报（JSON 对象无序；上游目前也不做这件事）。
4. 流式接口不受审计（它是上游的 transform，原样保留）。
5. 裸 token、`0.0.1`、`C:\temp`、URL 这类"非 JSON 方言"只做保守归类，不替你判断作者意图。

设计与证据全文：[docs/jsonledger.md](jsonledger.md)。
