# GProxy Prompt Cache 插件分析与改进方案

## 一、插件功能概述

### 背景：GProxy 与 Claude 提示词缓存

GProxy 是一个 Claude API 代理服务。Claude API 原生支持**提示词前缀缓存（Prompt Caching）**：在 API 请求中用 `cache_control` 标记某个位置，Claude 会将该标记之前的所有内容缓存下来。下次请求时，若该位置之前的内容字节完全一致，则命中缓存，读取价格约为正常输入 token 的 10%（写入时为 1.25x，但后续每次读取均为 0.1x）。

SillyTavern 本身无法直接在 API 请求里插入 `cache_control` 参数。GProxy 的解决方案是：在消息文本里识别特定的**魔法字符串（Magic Trigger）**，代理层将其转换为正式的 `cache_control` API 参数。本插件的核心工作，就是在每次发送请求前，自动将这些魔法字符串插入到正确的位置。

### 插件的运作方式

插件在每次真实发送（非 Prompt Manager 干跑）前，拦截 `CHAT_COMPLETION_PROMPT_READY` 事件，对聊天历史做如下处理：

**前提条件**：AI 助手的回复必须包含 `<details><summary>摘要</summary>...</details>` 格式的折叠块，同时具备完整正文和摘要。包含此结构的 AI 消息称为"受管消息（managed message）"。

**核心参数**：体窗口基数 `x`（默认为 10）。

**处理逻辑**：

1. 统计聊天历史中受管消息的总数 `total`
2. 用公式计算边界位置：
   ```
   boundary = floor(total / x) * x - x
   （当 total < 2x 时，boundary = 0，不触发压缩）
   ```
3. 位置 `1` 到 `boundary` 的受管消息：只保留摘要，删除正文（压缩旧历史）
4. 位置 `boundary + 1` 到 `total` 的受管消息：保留完整正文（近期上下文）
5. 在两个位置插入 GProxy 缓存触发字符串：
   - **T①**：`boundary` 处（最后一条摘要-only 消息）
   - **T②**：`total` 处（最后一条受管消息）

**boundary 的跳跃规律**（以 x=10 为例）：

| total | boundary | 摘要区 | 正文区 |
|-------|----------|--------|--------|
| 1–19  | 0        | 无     | 全部   |
| 20–29 | 10       | 1–10   | 11–N  |
| 30–39 | 20       | 1–20   | 21–N  |

boundary 每累积 x 条受管消息才跳一次，而非每轮都变。这是触发点 T① 能稳定命中的关键。

---

## 二、缓存机制分析

### Claude 前缀缓存的命中条件

缓存命中的充要条件：**本次请求从头到缓存断点的全部内容，与上次建立该缓存时字节完全一致。**

断点后的内容无关紧要，但断点前任何一个 token 的变化都会导致 Miss。

### 计费结构

| 情况 | 单价 |
|------|------|
| 普通输入（无缓存） | 1x |
| Cache Write（建立缓存） | 1.25x |
| Cache Read（命中缓存） | 0.1x |

Cache Write 比普通输入更贵，需要通过多次命中来摊销成本。若每次写入后从不命中，实际付出高于不使用缓存。

### T① 的表现：有效

boundary 每 x 轮才移动一次，因此 T① 所在消息的内容及其之前的所有前缀，在一个 batch 内（x 轮）完全不变 → **每轮命中，每 x 轮重建一次**。

### T②（原方案）的表现：实际有害

T② 当前放在"最后一条受管消息"上，每次有新的受管消息加入，T② 就移到新的位置。

**正常对话流追踪（x=10，boundary=10）**：

```
第N轮（total=20）:  [...ai19正文][ai20正文+T②][u21当前消息]
                    ↑ 建立缓存 C_N，断点在 ai20
第N+1轮（total=21）:[...ai19正文][ai20正文][u21][ai21正文+T②][u22当前消息]
                    ↑ 断点移到 ai21，前缀已变 → Miss，建立新缓存 C_N+1（付 1.25x）
第N+2轮（total=22）:T② 移到 ai22 → Miss，再付 1.25x
...
```

**结论：正常对话中，T② 每轮触发一次 Cache Write（1.25x），但从不触发 Cache Read（0.1x）。比完全不用缓存还贵。**

T② 仅在**重新生成（Regen/Swipe）**时有效：此时 total 不变，T② 仍在同一条消息上，前缀与上轮完全一致 → Hit。

---

## 三、改进方案

### 核心思路

将 T② 放在一个**跨轮次固定不变**的位置，使其前缀在整个 batch 内保持稳定。

body 区内的历史消息内容是固定的（不会被修改），新消息只追加在末尾。因此，任何"非末尾"的历史位置，其之前的前缀都是稳定的。

### 新 T② 位置：`boundary + x - 1`

```javascript
const trigger2Position = boundary + settings.bodyLayerBase - 1;
```

**稳定性证明**（x=10，boundary=10，trigger2Position=19）：

```
第N轮（total=20）:   T② 在 ai19，前缀=[摘要1..10][正文11..19+T②]
第N+1轮（total=21）: T② 仍在 ai19，前缀=[摘要1..10][正文11..19+T②] → HIT ✓
第N+2轮（total=22）: T② 仍在 ai19 → HIT ✓
...
第N+9轮（total=29）: T② 仍在 ai19 → HIT ✓
第N+10轮（total=30）: boundary 跳到 20，T② 移到 29 → Miss，重建
```

在整个 batch 的 10 轮里，T② 固定在同一条消息上，命中率从约 0% 提升到约 90%（10 轮中 9 次命中，1 次重建）。

Regen 场景同样自动兼容：total 不变，T② 位置不变，前缀一致 → Hit。

### 三层缓存结构

Claude API 支持最多 4 个缓存断点，目前原方案只用了 2 个，改进后使用 3 个：

```
T①（boundary）        → 缓存整个摘要区，稳定 x 轮
T②（boundary + x - 1）→ 缓存 body 区前段（x-1 条正文），稳定 x 轮  ← 新
T③（最后一条）         → 仅 Regen 时命中，正常对话 Miss（原 T②）
```

**各场景表现**：

| 场景 | T① | T②（新） | T③ |
|------|----|----------|-----|
| 正常对话 | 命中 | 命中 | Miss |
| 重新生成 | 命中 | 命中 | 命中 |

### 代码修改

在 `index.js` 的 `applyPromptRewrite` 函数中，将判断逻辑从：

```javascript
const isBoundaryMessage    = boundary > 0 && position === boundary;
const isLastManagedMessage = position === managedMessages.length;

if (isBoundaryMessage || isLastManagedMessage) {
    nextText = appendMagicTrigger(nextText, trigger);
}
```

改为：

```javascript
const bodyMidPosition = boundary + settings.bodyLayerBase - 1;

const isBoundaryMessage = boundary > 0 && position === boundary;
const isBodyMidBoundary = boundary > 0
    && position === bodyMidPosition
    && position < managedMessages.length; // 防止与 T③ 重叠
const isLastManagedMessage = position === managedMessages.length;

if (isBoundaryMessage || isBodyMidBoundary || isLastManagedMessage) {
    nextText = appendMagicTrigger(nextText, trigger);
}
```

边界情况说明：
- `bodyMidPosition < boundary + 1`（即 x < 1）：不合法，已由参数校验防护
- `bodyMidPosition >= managedMessages.length`：body 区不足 x 条时，guard 条件使 T② 不生效，退化为只有 T①+T③

---

## 四、ST 预设配合的必要性

上述改进只优化了**聊天历史内部**的缓存结构，但 T① 之前还有一层威胁：**条件激活的世界书词条（绿灯词条）**。

### 问题来源

SillyTavern 的 prompt 默认结构是：

```
[角色卡 / System]
[Always On 世界书词条]
[绿灯触发词条]            ← 动态，根据关键词激活/失活
[聊天历史]
  [...T①...T②...T③]
[当前用户消息]
```

绿灯词条在 T① 之前。一旦某个词条因关键词出现或消失而改变激活状态，T① 之前的前缀就不同了 → T①、T② 全部 Miss。

插件无法感知或控制世界书内容，但 T① 的命中依赖其前缀的稳定性，因此需要 ST 侧的配置配合。

### 解决方案

将所有绿灯词条的注入位置改为 **Outlet**，并通过 Prompt Manager 将对应的 outlet 宏放置在聊天历史之后。这样：

- T① 之前只剩角色卡和 Always On 词条（稳定内容）
- 绿灯词条在 T③ 之后渲染，不再破坏任何缓存前缀
- 词条的触发逻辑（关键词扫描）完全不受影响

具体配置方法见《SillyTavern 配置指南》。

---

## 五、改进效果汇总

| 问题 | 原方案 | 改进后 |
|------|--------|--------|
| T② 正常对话命中率 | ~0%（主动亏钱） | ~90% |
| T② Regen 命中率 | 100% | 100% |
| 绿灯词条破坏 T① | 每次词条变化即失效 | 完全隔离，不影响 |
| 使用缓存断点数 | 2/4 | 3/4 |
| 每 batch 重建次数 | T①：1次，T②：每轮 | T①②：各 1 次 |
