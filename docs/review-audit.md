# 文档独立审查结论（2026-04-26）

## 结论摘要

- `docs/plugin-analysis.md` 对当前扩展实现机制的描述与 `index.js` 基本一致：
  - 受管消息识别依赖 `<details><summary>摘要</summary>...</details>` 结构；
  - `boundary = floor(total / x) * x - x`（在 `total < 2x` 时为 `0`）；
  - 现状仅在 `boundary` 与“最后一条受管消息”打 trigger。
- 文档提出的“将 T② 固定到 `boundary + x - 1`，并保留末尾触发点作为 T③”的方向是合理的，且与现有代码结构兼容。
- `docs/st-configuration-guide.md` 中通过 Outlet 将动态世界书从聊天历史前移到历史后方的方案，在缓存前缀稳定性上是正确的。
- **新增外部核验结论**：gproxy 上游源码与文档的“magic trigger → `cache_control` 转写”叙述一致，且确实在 Anthropic/ClaudeCode 通道的 `finalize_request(...)` 阶段统一处理。

## 审查依据（与本仓库源码对照）

1. **边界算法对照**
   - 文档公式与源码 `computeBoundary` 一致，且阈值条件（`total < 2x` 不压缩）一致。
2. **触发点现状对照**
   - 源码当前仅在 `isBoundaryMessage || isLastManagedMessage` 时附加 trigger，对应文档“现有两层断点（T①、T②）”的描述。
3. **改法可落地性**
   - 在 `applyPromptRewrite` 中增设 `isBodyMidBoundary` 条件即可实现，不需要改动事件钩子、设置存储或 UI 结构。

## 新增核验：gproxy 上游对 trigger 的真实转写路径

> 核验时间：2026-04-26（UTC）

1. **上游文档明确了实现入口与文件**
   - gproxy 官方文档（`guides/claude-caching`）明确写到：
     - magic string trigger 功能由服务端开启 `settings.enable_magic_cache` 后生效；
     - 触发字符串会在服务端被剥离并改写为 `cache_control`；
     - 具体实现文件是 `sdk/gproxy-channel/src/utils/claude_cache_control.rs`。

2. **上游源码存在与本插件完全匹配的三组常量**
   - `claude_cache_control.rs` 中定义了三条固定 sentinel（auto / 5m / 1h），字符串值与本仓库 `index.js` 的 `MAGIC_TRIGGERS` 一致。

3. **转写函数与行为存在且语义吻合**
   - 上游存在 `apply_magic_string_cache_control_triggers(...)`，会：
     - 在 `system` 与 `messages` 内容块中扫描并移除 magic 字符串；
     - 在可用断点槽位（最多 4 个）内为命中块补写 `cache_control: { type: "ephemeral", ttl? }`；
     - 避免覆盖已有 `cache_control`。

4. **调用时机在通道 finalize 阶段**
   - `channels/anthropic.rs` 与 `channels/claudecode.rs` 都引入了 `claude_cache_control` 工具；
   - `anthropic.rs` 的 `finalize_request(...)` 中，在请求发往上游前执行：
     - `if settings.enable_magic_cache { apply_magic_string_cache_control_triggers(...) }`
     - 随后再做规则断点补全与 body sanitize。
   - 这与“代理层把魔法字符串转为正式 API 字段”的机制描述一致。

## 认为需要补充/修正的地方

1. **命中率表述建议改为“近似”**
   - 文档中“~90%”是基于理想追加对话（每轮新增 1 条受管 assistant 消息）的推导。若用户编辑历史、修改 summary 标题、切换预设导致前缀变化，实际命中率会下降。建议在文档中明确“典型场景近似值”。

2. **对 T③ 价值的描述可更谨慎**
   - “正常对话 Miss、Regen Hit”总体成立，但若前缀区（如系统提示、世界书稳定区）被改动，Regen 也会 Miss。建议把“命中”表述为“在前缀不变时命中”。

3. **ST 侧配置存在可运维风险**
   - 方案依赖人工维护“哪些词条属于动态绿灯词条”。若漏改，会周期性破坏前缀。建议在指南增加“抽样检查流程”（例如每次新增词条后验证一轮 Cache Read）。

4. **建议补一节“回滚策略”**
   - 新增 T② 后若出现兼容问题（例如某些第三方 prompt 后处理器异常），文档应给出可回滚路径：先仅启用 T①+T③，再逐步恢复 T②。

## 最终判断

- **描述准确性**：高（本仓库实现与 gproxy 上游转写机制都可对上）。
- **修改方案合理性**：高（收益明确、改动小、兼容性风险可控）。
- **落地建议**：可实施，但应同步补充“命中率前提条件 + 运维检查 + 回滚策略”三项说明，避免过度承诺收益。
