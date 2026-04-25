# SillyTavern 配置指南：配合 GProxy Prompt Cache 使用

## 一、为什么需要配置 ST

GProxy Prompt Cache 插件的缓存断点（T①、T②）都位于聊天历史内部。Claude 的前缀缓存要求断点之前的所有内容字节完全一致，才能命中缓存。

**威胁来源**：条件激活的世界书词条（绿灯词条）默认注入在聊天历史之前。一旦某个词条因关键词匹配状态发生变化（激活或失活），断点之前的前缀就改变了，所有缓存断点同时 Miss。

**解决思路**：把绿灯词条的落点挪到聊天历史之后。动态内容放在所有缓存断点的后面，就不会影响断点前缀的稳定性。

最终 prompt 结构目标：

```
[角色卡 / System]              ← 稳定
[Always On 世界书词条]          ← 稳定
[聊天历史]
  [...摘要区 + T①]             ← 缓存断点
  [...正文区前段 + T②]         ← 缓存断点
  [最新正文 + T③]              ← 缓存断点
[绿灯词条渲染区]                ← 动态，但在所有断点之后
[当前用户消息]
```

---

## 二、World Info Outlet 机制

SillyTavern 的世界书词条有一个特殊的 Position 选项：**Outlet**。

- 设为 Outlet 的词条**不会被自动注入**到 prompt 的任何位置
- 需要在 Prompt Manager（预设）里用宏 `{{outlet::名称}}` 手动指定落点
- 宏所在的位置就是这些词条内容最终出现的位置
- 词条的**触发逻辑（关键词扫描、激活条件）完全不变**，只是注入位置改由宏控制

多个词条可以共用同一个 Outlet 名称，它们的内容会在宏所在位置按 Insertion Order 排列拼合。

---

## 三、Prompt Manager 配置

### 第一步：新建"Dynamic World Info"提示块

1. 打开 Prompt Manager（界面中的 **P** 按钮）
2. 点击 **+** 新建一个提示块
3. 填写以下内容：

   | 字段 | 填写内容 |
   |------|----------|
   | Name | `Dynamic World Info`（随意，方便识别） |
   | Role | `System` |
   | Content | `{{outlet::dynamic_wi}}` |

4. 确认该块的开关处于**启用（enabled）**状态

### 第二步：调整块的排列顺序

在 Prompt Manager 的拖拽列表中，将 `Dynamic World Info` 块拖到 **`[Chat History]` 块的正下方**。

完成后，顺序示意如下：

```
✅ [Main Prompt]
✅ [Character Description]
✅ [World Info (Above)]
   ...（其他稳定块）...
✅ [Chat History]
✅ [Dynamic World Info]     ← 新建的块，紧跟 Chat History 之后
✅ [Post-History Instructions]（如有）
```

> **注意**：`Dynamic World Info` 必须在 `[Chat History]` 之后，不能在之前。否则词条内容仍会出现在缓存断点之前，起不到隔离效果。

---

## 四、世界书词条配置

对每一个**条件激活（绿灯）的词条**执行以下操作：

### 第一步：打开词条编辑

在世界书编辑界面，找到需要修改的词条，点击进入编辑。

### 第二步：修改 Position

找到 **Position** 下拉框，将其从原来的值（通常是 `Before Char Defs` 或 `@ Depth`）改为 **`Outlet`**。

### 第三步：填写 Outlet Name

选择 `Outlet` 后，下方会出现一个新字段 **Outlet Name**。

填写：`dynamic_wi`

> 这个名称必须与 Prompt Manager 里写的 `{{outlet::dynamic_wi}}` 中的名称**完全一致**（区分大小写）。

### 第四步：保存

保存词条。

---

## 五、不需要修改的词条

以下类型的词条**不需要改动**，保持原来的 Position 设置即可：

| 词条类型 | 原因 |
|----------|------|
| **Always On** 词条 | 永远激活，prompt 中始终存在，不会造成前缀变化 |
| 由**开局固定内容**触发的词条 | 触发词在最早的消息里，激活后一直保持激活状态，等同于稳定内容 |
| 专门放在 `[Chat History]` **之后**（高 Depth）的词条 | 本来就在缓存断点之后，不影响前缀 |

只需要修改那些**会随剧情发展动态开关**的词条（例如：进入战斗时激活的战斗词条、到达特定地点时激活的场景词条等）。

---

## 六、验证配置是否生效

配置完成后，可以用以下方式确认效果：

1. 打开一个已有的对话（有足够聊天历史）
2. 触发某个绿灯词条（让它激活）
3. 发送一条消息
4. 再发送一条消息
5. 在 GProxy 的日志或计费面板中，观察 Cache Read（命中）的 token 数量

如果 T① 的命中量稳定，说明绿灯词条的动态变化已经不再破坏缓存前缀。

---

## 七、完整配置检查清单

```
Prompt Manager
  ☐ 新建 "Dynamic World Info" 块，Content 为 {{outlet::dynamic_wi}}
  ☐ 块的 Role 设为 System
  ☐ 块已启用
  ☐ 块位于 [Chat History] 之后

世界书词条
  ☐ 所有动态绿灯词条的 Position 改为 Outlet
  ☐ 所有动态绿灯词条的 Outlet Name 填写 dynamic_wi
  ☐ Always On 词条保持不变
  ☐ 开局固定触发词条保持不变
```
