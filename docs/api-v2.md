# 待办中心 2.0 接口与数据规格

| 项 | 内容 |
| --- | --- |
| 文档版本 | 2.0 |
| 日期 | 2026-11-03 |
| 负责角色 | engineering-backend-architect |
| 依据 | `docs/PRD-v2.md`（877 行，需求与验收的唯一依据）、`docs/PRD.md` v1.1、`docs/api.md` v1.1、`lib/index.js`（715 行）、`lib/client.js`（1527 行） |
| 范围 | 2.0 数据文件结构、19 条路由的请求与响应、校验规则与错误文本、重复实例推进、提醒判定、筛选预设、导入与撤销、升级流程、会话待确认事项、接口层验收 |
| 不在范围 | 界面布局与视觉（`docs/ui-spec-v2.md`）、挂载点与平台能力核实（`docs/architecture-v2.md`）、需求裁定与验收编号（`docs/PRD-v2.md`） |

本文是 `docs/api.md` 的增量文档。本文没有写到的传输规则、字段含义、写队列要求沿用 `docs/api.md` 原文。两者冲突时以本文为准，需求冲突以 `docs/PRD-v2.md` 第 2 节为准。

## 1. 结论

1. 数据文件版本从 1 升到 2，结构按 `docs/PRD-v2.md` 3.1 节执行，含 `version`、`todos`、`collapsed`、`filters`、`settings`、`meta` 六段。`TodoItem` 增加八个字段，均在 3.2 节逐条给出取值范围。
2. 版本 1 的文件按只读方式加载：`GET /snapshot` 返回 200，`dataVersion` 为 1，`readOnly` 为 true，缺失字段按缺省值补齐；其它全部写路由返回 400 并给出「数据格式为 1.0，请先升级」。升级由 `POST /upgrade` 完成，升级前复制原文件为 `todos.v1-<时间戳>.json`。
3. 路由从 9 条扩到 19 条。既有 9 条中，`/snapshot`、`/create`、`/update`、`/complete`、`/fromConversation` 五条扩展字段或规则，`/reopen`、`/remove`、`/setQuadrant`、`/setCollapsed` 四条规则不变；新增 10 条：`GET /reminders`、`POST /snooze`、`POST /duplicateRecurrence`、`POST /filterSave`、`POST /filterRemove`、`GET /export`、`POST /import`、`POST /import/undo`、`POST /upgrade`、`GET /pending`。
4. 重复实例只在 `POST /complete` 内生成，链首的 `seriesId` 在第一次完成时写入。去重依据为「同一 `seriesId` 与同一 `dueAt` 只允许一条未删除的顶层条目」，因此重复提交完成请求不会产生第二条。
5. 提醒由 Host 半的常驻定时器每 30 秒扫描一次，命中即写 `remindedAt`；客户端用 `GET /reminders` 拉取已提醒但未完成的条目。提醒只写一次，改期与撤销会清除 `remindedAt`。
6. 统计、今日视图分区、快速录入解析都由客户端用全量快照计算，Host 不提供对应路由。`docs/PRD-v2.md` F1、F2、F6 三节已经这样规定。
7. 导入为整份替换，校验在写入前完成，写入前复制当前文件为 `todos.before-import-<时间戳>.json`；`POST /import/undo` 用该备份写回。

## 2. 传输层

### 2.1 通则

| 项 | 规定 |
| --- | --- |
| 前缀 | `/plugins/dsh-todo-center`，全部为 `exact` 路由 |
| 读请求 | `GET`，查询参数放在 URL，无请求头要求 |
| 写请求 | `POST`，必须带 `content-type: application/json` 与 `x-dsh-todo: 1`；缺写入标记返回 403 |
| 请求体上限 | 默认 1 MiB；`POST /import` 为 32 MiB。超限返回 400 |
| 成功响应 | `{ "ok": true, "value": { } }` |
| 失败响应 | `{ "ok": false, "error": "可直接展示的中文原因" }` |
| 状态码 | 200 成功；400 请求内容不合法；403 缺写入标记；500 数据文件不可读、不可解析、结构不合法、不可写 |
| 时区 | 时间在文件内一律为带时区标识的 ISO 8601 字符串；「今天」「本周」「本月」的边界在客户端按本机时区计算，Host 只在提醒判定与逾期判定中使用 `Date.parse` 的绝对时刻 |

`error` 文本必须包含定位信息：数据文件错误含绝对路径与失败位置，请求字段错误含字段名，导入错误含条目序号与字段名。

### 2.2 路由清单

| 序 | 路由 | 方法 | 用途 | 相对 v1.1 |
| --- | --- | --- | --- | --- |
| 1 | `/snapshot` | GET | 全量数据、版本状态、筛选预设、设置 | 响应扩展 |
| 2 | `/create` | POST | 新建顶层或子待办，可带标签、重复、提醒 | 请求扩展 |
| 3 | `/update` | POST | 改标题、描述、截止时间、标签、重复、提醒、会话标记 | 请求扩展 |
| 4 | `/complete` | POST | 完成一组条目，带重复时生成下一条 | 规则扩展 |
| 5 | `/reopen` | POST | 撤销完成，清除提醒记录 | 规则扩展 |
| 6 | `/remove` | POST | 删除条目与其子待办 | 不变 |
| 7 | `/setQuadrant` | POST | 改象限，作用于其子待办 | 不变 |
| 8 | `/setCollapsed` | POST | 记录方格折叠状态 | 不变 |
| 9 | `/fromConversation` | POST | 由会话条目生成待办，含可选的标签 | 请求扩展 |
| 10 | `/reminders` | GET | 已提醒且未完成的条目与计数 | 新增 |
| 11 | `/snooze` | POST | 稍后 10 分钟 | 新增 |
| 12 | `/duplicateRecurrence` | POST | 把一条的重复设置复制到另一条 | 新增 |
| 13 | `/filterSave` | POST | 新建或更新筛选预设 | 新增 |
| 14 | `/filterRemove` | POST | 删除筛选预设 | 新增 |
| 15 | `/export` | GET | 取完整数据文件对象 | 新增 |
| 16 | `/import` | POST | 整份替换 | 新增 |
| 17 | `/import/undo` | POST | 用备份写回 | 新增 |
| 18 | `/upgrade` | POST | 把版本 1 文件升级为版本 2 | 新增 |
| 19 | `/pending` | GET | 列出某一会话正在等待确认的提问与审批 | 新增 |

### 2.3 只读兼容期的拦截

数据文件的 `version` 为 1 时，除 `GET /snapshot`、`GET /export`、`POST /upgrade` 之外的写路由在读取文件之后、修改数据之前返回 400，`error` 为「数据格式为 1.0，请先升级」。拦截发生在写队列内，与其它写请求共用同一条队列，因此不会与升级请求交错执行。

## 3. 数据文件 2.0

### 3.1 结构

```json
{
  "version": 2,
  "todos": [],
  "collapsed": {},
  "filters": [],
  "settings": {
    "reminderLeadMinutes": 30,
    "statsRange": "week"
  },
  "meta": {
    "upgradedAt": null,
    "upgradedFrom": null
  }
}
```

| 段 | 类型 | 规则 |
| --- | --- | --- |
| `version` | `number` | 2.0 写入时为 2；读取时接受 1 与 2 |
| `todos` | `TodoItemV2[]` | 全部条目，含子待办；加载时不设条目上限，导入时上限为 20000 条 |
| `collapsed` | `{ [scopeKey]: { [quadrant]: boolean } }` | `scopeKey` 为工作区标识或 `all`；四个象限标识到布尔值的映射 |
| `filters` | `FilterPreset[]` | 不超过 20 条，顺序即展示顺序 |
| `settings` | `Settings` | 三个字段，缺失时按 3.5 节补齐 |
| `meta` | `Meta` | `upgradedAt` 为升级时刻，`upgradedFrom` 为升级前的版本号；未升级过时两者为 `null` |

### 3.2 TodoItemV2

沿用 `docs/api.md` 第 3 节的字段，追加八项：

| 字段 | 类型 | 规则 | 子待办 |
| --- | --- | --- | --- |
| `tags` | `string[]` | 0 至 10 项，每项 1 至 20 字，同一条内不重复，去首尾空白，保持输入顺序 | 恒为空数组 |
| `recurrence` | `Recurrence \| null` | 非空表示完成后生成下一条；链首创建时可为空 `seriesId` | 恒为 `null` |
| `seriesId` | `string \| null` | 形如 `s_<uuid>`；同一链全部条目共享；链首在第一次完成时写入 | 恒为 `null` |
| `generatedFromId` | `string \| null` | 由哪条生成；链首为 `null` | 恒为 `null` |
| `reminder` | `Reminder \| null` | 空表示不提醒 | 恒为 `null` |
| `remindedAt` | `string \| null` | 最近一次提醒的写入时刻；空表示未提醒 | 恒为 `null` |
| `startedSessionId` | `string \| null` | 由该条发起的会话标识 | 恒为 `null` |
| `startedAt` | `string \| null` | 发起会话的时刻，与 `startedSessionId` 同时有值或同时为空 | 恒为 `null` |

```ts
interface Reminder {
  leadMinutes: 0 | 5 | 15 | 30 | 60 | 1440
  snoozeUntil: string | null   // 稍后 10 分钟的下一次判定时刻
}

interface Recurrence {
  freq: 'daily' | 'weekly' | 'monthly'
  interval: number             // 1..12
  until: string | null         // 最后一条实例的计划截止时间上限，带时区标识的 ISO 8601
}
```

### 3.3 FilterPreset

```ts
interface FilterConditions {
  tags: string[]                                   // 0..10 项，匹配口径为「同时含有全部」
  quadrants: Quadrant[]                            // 空数组表示不限
  dueState: 'all' | 'overdue' | 'notOverdue' | 'noDue'
  dueRange: { kind: 'any' | 'today' | 'week' | 'range', from: string | null, to: string | null }
  source: 'all' | 'manual' | 'conversation'
  keyword: string                                  // 0..100 字，空字符串表示不限
}

interface FilterPreset {
  id: string                                       // 形如 f_<uuid>
  name: string                                     // 1..40 字，去首尾空白，同一文件内不重名
  conditions: FilterConditions
  createdAt: string
  updatedAt: string
}
```

规则：

1. `dueRange.kind` 为 `range` 时 `from` 与 `to` 必填，格式为本地日期 `YYYY-MM-DD`，两端都含，`from` 不晚于 `to`；其它取值时两者为 `null`。
2. 条件里出现、但当前数据中已无匹配的标签不报错，由客户端提示「以下标签已无匹配」。
3. 预设保存时按上述缺省值补齐缺失字段，保证同一语义只有一种写法。

### 3.4 Settings 与 Meta

| 字段 | 类型 | 缺省 | 规则 |
| --- | --- | --- | --- |
| `reminderLeadMinutes` | `number` | `30` | 新待办的默认提醒提前量，取值为 0、5、15、30、60、1440 之一 |
| `statsRange` | `'week' \| 'month' \| 'quarter' \| 'custom'` | `week` | 统计页默认区间 |
| `meta.upgradedAt` | `string \| null` | `null` | 升级时刻 |
| `meta.upgradedFrom` | `number \| null` | `null` | 升级前的版本号，取值 1 |

`settings` 没有写入路由：两项都是新待办与统计页的缺省值，界面提供控件时不写回。需要改默认值时手工编辑数据文件，读取时按上表校验并补齐。

### 3.5 加载校验

每次请求重新读取文件并完整校验，不保留进程内副本。校验顺序固定，第一处失败即抛出，响应 500，`error` 文本为「数据文件结构不合法: <绝对路径>，<失败位置与原因>」。校验不通过时不写入任何内容。

| 序 | 校验项 | 失败文本要点 |
| --- | --- | --- |
| 1 | 顶层是对象 | 顶层必须是对象 |
| 2 | `version` 为 1 或 2 | 数据文件版本不受支持，实际 <值>，允许 1 或 2 |
| 3 | `todos` 是数组 | todos 必须是数组 |
| 4 | `collapsed` 结构：每个键是对象，象限键属于四个标识，值为布尔 | collapsed.<scopeKey>.<quadrant> 必须是布尔值 |
| 5 | `filters` 是数组且不超过 20 条，逐条按 3.3 校验 | 第 <n> 条筛选预设的 <字段> 不合法 |
| 6 | `settings` 按 3.4 校验，缺失字段补齐 | settings.<字段> 不合法 |
| 7 | `meta` 结构 | meta.<字段> 不合法 |
| 8 | `todos` 逐条按 3.2 校验，含枚举、长度、时间格式、标签、重复、提醒 | 第 <n> 条待办的 <字段> <原因> |
| 9 | 条目标识唯一 | 第 <n> 条待办的 id 与前面的条目重复: <id> |
| 10 | 子待办的 `parentId` 指向存在的顶层待办 | 第 <n> 条待办的 parentId 未指向存在的顶层待办: <id> |
| 11 | 顶层条目的 `sourceKey` 唯一 | 第 <n> 条待办的 sourceKey 与前面的条目重复: <键> |
| 12 | `status` 为 `done` 的条目 `completedAt` 非空，`status` 为 `open` 的条目 `completedAt` 为 `null` | 第 <n> 条待办的 status 与 completedAt 不一致 |
| 13 | `startedSessionId` 与 `startedAt` 同时有值或同时为空 | 第 <n> 条待办的会话标记不完整 |
| 14 | 同一 `seriesId` 与同一 `dueAt` 最多一条条目 | 第 <n> 条待办与第 <m> 条待办的 seriesId 与 dueAt 相同 |

第 2 条对版本 1 的特殊处理：版本 1 的文件按 3.6 节补齐字段后继续校验，补齐只发生在内存中。

### 3.6 版本 1 的只读加载

| 步骤 | 内容 |
| --- | --- |
| 读取 | 按 v1.1 的结构校验 `version`、`todos`、`collapsed` |
| 补齐 | 每条条目补 `tags: []`、`recurrence: null`、`seriesId: null`、`generatedFromId: null`、`reminder: null`、`remindedAt: null`、`startedSessionId: null`、`startedAt: null`；顶层补 `filters: []`、`settings` 取 3.4 缺省、`meta: { upgradedAt: null, upgradedFrom: null }` |
| 后续校验 | 补齐后的结构按 3.5 节第 3 至 14 条继续校验 |
| 写操作 | 全部写路由返回 400「数据格式为 1.0，请先升级」，不修改文件 |
| 响应标记 | `GET /snapshot` 的 `dataVersion` 为 1，`readOnly` 为 true |

### 3.7 写入

沿用 v1.1 的实现：每次写入使用独立临时文件名 `todos.json.<进程号>.<递增序号>.tmp`，写完重命名覆盖正式文件，失败时删除本次临时文件并返回 500，`error` 为「数据文件不可写: <绝对路径>，<原因>」。写出前先按 3.5 节校验待写内容，校验不通过时不写。

## 4. 既有 9 条路由在 2.0 的变更

### 4.1 `GET /snapshot`

响应 `value`：

```json
{
  "dataVersion": 2,
  "readOnly": false,
  "todos": [],
  "collapsed": {},
  "filters": [],
  "settings": { "reminderLeadMinutes": 30, "statsRange": "week" },
  "meta": { "upgradedAt": null, "upgradedFrom": null }
}
```

`todos` 含顶层与子待办，顺序不保证，由客户端排序。`dataVersion` 与 `readOnly` 供界面显示升级横幅与禁用写操作。

### 4.2 `POST /create`

请求：`{ title, description?, dueAt?, quadrant, parentId?, workspaceId?, source?, tags?, recurrence?, reminder? }`

新增规则：

1. `tags` 省略为空数组，按 3.2 节规范化：去首尾空白、丢弃空项、按首次出现去重、保持顺序。超过 10 项、单项超过 20 字、含换行时返回 400。
2. `recurrence` 只允许顶层条目，且 `source.kind` 为 `manual`。子待办带该项返回 400「子待办不支持重复设置」；会话来源带该项返回 400「会话来源的待办不支持重复设置」。
3. `reminder` 只允许顶层条目，`leadMinutes` 必须取自 0、5、15、30、60、1440；省略时取 `settings.reminderLeadMinutes`；显式传 `null` 表示不提醒。
4. 新建带 `recurrence` 的条目时 `seriesId` 与 `generatedFromId` 都为 `null`，`seriesId` 在第一次完成时写入。
5. 子待办的八个新字段一律取恒定值（`tags` 为空数组，其余为 `null`），请求里带非恒定时返回 400。

响应 `value`：`WriteResult & { focusId: string }`。

### 4.3 `POST /update`

请求：`{ id, title?, description?, dueAt?, tags?, recurrence?, reminder?, startedSessionId?, startedAt? }`

| 字段 | 规则 |
| --- | --- |
| `title`、`description`、`dueAt` | 校验同 v1.1；`dueAt` 变化时把该条 `remindedAt` 置为 `null` |
| `tags` | 整组替换，传空数组即清空；子待办带该项返回 400 |
| `recurrence` | 传 `null` 表示取消重复，保留 `seriesId` 与 `generatedFromId` 供追溯；非空时按 3.2 校验，只允许顶层条目 |
| `reminder` | 整组替换；传 `null` 表示不提醒；`reminder` 变化时把 `remindedAt` 置为 `null`；`snoozeUntil` 只由 `/snooze` 写入，本字段传入时忽略 |
| `startedSessionId`、`startedAt` | 同时传或同时不传；同时传时两者都必须非空字符串；只由发起会话流程写入 |

响应 `value`：`WriteResult`。

### 4.4 `POST /complete`

请求：`{ ids: string[], includeChildren: boolean }`

在 v1.1 的四条规则之上增加：

1. 完成的顶层条目满足下列全部条件时，在同一事务内生成下一条：`recurrence` 非空、状态由 `open` 变为 `done`、`parentId` 为 `null`、下一条的计划截止时间不晚于 `recurrence.until` 或 `until` 为空。
2. 链首条目的 `seriesId` 为 `null` 且本次需要生成下一条时，先为这条链分配 `seriesId`，并同时写入已完成条目的 `seriesId` 与新条目的 `seriesId`。
3. 生成前按「同一 `seriesId` 与同一 `dueAt` 只允许一条条目」检查，已存在时不生成。
4. 下一条的计划截止时间晚于 `until` 时把已完成条目的 `recurrence` 置为 `null`，不生成。
5. 响应 `WriteResult` 同时含已完成条目与新建条目，客户端按 `id` 覆盖。

### 4.5 `POST /reopen`

请求：`{ ids: string[] }`

在 v1.1 的规则之上增加：

1. 撤销时把该条 `remindedAt` 置为 `null`；若此时已过提醒时间，下一次定时器扫描补发一次。
2. 撤销不删除已生成的下一条，也不回收 `seriesId`。

### 4.6 `POST /remove`

请求：`{ ids: string[] }`

规则不变：删除条目及其全部子待办，不存在的标识忽略。删除不影响链中其它条目，也不删除 `filters`。

### 4.7 `POST /setQuadrant`

请求：`{ ids: string[], quadrant: Quadrant }`

规则不变。顶层条目改象限时其全部子待办一并改；子待办单独收到该请求时忽略，不报错。

### 4.8 `POST /setCollapsed`

请求：`{ scopeKey: string, quadrant: Quadrant, collapsed: boolean }`

响应 `value`：`{ "collapsed": { } }`，返回写入后的完整 `collapsed`。规则不变。

### 4.9 `POST /fromConversation`

请求：`{ sessionId, entryType, entryId, title, description, quadrant?, workspaceId?, dueAt?, tags? }`

新增规则：`tags` 按 3.2 节校验与规范化；`recurrence` 与 `reminder` 不接受，传了返回 400。去重规则沿用 `sourceKey`，命中时返回既有条目的 `focusId` 与 `existing: true`。

## 5. 新增路由

### 5.1 `GET /reminders`

响应 `value`：

```json
{
  "count": 2,
  "at": "2026-11-03T13:30:14.000Z",
  "readOnly": false,
  "items": [
    {
      "id": "t_0f1c",
      "title": "交季度报告",
      "quadrant": "urgent-important",
      "workspaceId": null,
      "dueAt": "2026-11-03T14:00:00.000Z",
      "remindedAt": "2026-11-03T13:30:12.000Z",
      "leadMinutes": 30,
      "minutesUntilDue": 29
    }
  ]
}
```

筛选条件：`status` 为 `open`、`parentId` 为 `null`、`remindedAt` 非空、`dueAt` 非空。排序按 `dueAt` 从早到晚，相同时按 `id` 升序。`minutesUntilDue` 为 `Math.round((Date.parse(dueAt) - now) / 60000)`，到期后为负值。`at` 为本次读取时刻，`readOnly` 与 `GET /snapshot` 同义。该路由只读，不写入，不修改 `remindedAt`；数据文件为版本 1 时返回 `count: 0`、空数组与 `readOnly: true`。

### 5.2 `POST /snooze`

请求：`{ id, minutes }`，`minutes` 取 10。

规则：把 `reminder.snoozeUntil` 置为当前时刻加 `minutes` 分钟，把 `remindedAt` 置为 `null`。条目不存在返回 400；`reminder` 为 `null` 时先写入 `{ leadMinutes: settings.reminderLeadMinutes, snoozeUntil }`。响应 `value`：`WriteResult`。

### 5.3 `POST /duplicateRecurrence`

请求：`{ sourceId, targetId }`

规则：把 `sourceId` 的 `recurrence` 复制到 `targetId`，覆盖目标原有取值；目标为子待办时返回 400；目标已有 `recurrence` 时覆盖，确认由界面完成。`seriesId` 与 `generatedFromId` 不复制，目标在第一次完成时按 4.4 节第 2 条取得新的 `seriesId`。响应 `value`：`WriteResult`。

### 5.4 `POST /filterSave`

请求：`{ preset: { id?, name, conditions } }`

规则：

1. `id` 省略时新建，`filters` 已达 20 条返回 400「最多保存 20 个筛选条件」。
2. `id` 有值时整体替换该条的 `name` 与 `conditions`，刷新 `updatedAt`；`id` 不存在返回 400。
3. 名称去首尾空白后为空、超过 40 字、与本文件内其它预设重名时返回 400。
4. `conditions` 按 3.3 节校验并补齐缺省值。

响应 `value`：`{ "preset": { }, "filters": [] }`，`filters` 为写入后的完整数组。

### 5.5 `POST /filterRemove`

请求：`{ id }`

规则：删除该预设；`id` 不存在返回 400。响应 `value`：`{ "filters": [] }`。

### 5.6 `GET /export`

响应 `value`：完整数据文件对象，字段与 3.1 节一致，`version` 为 2；版本 1 文件按 3.6 节补齐后返回，`meta` 保持 `null` 取值。该路由只读。

### 5.7 `POST /import`

请求：`{ payload: object, fileName: string }`，请求体上限 32 MiB。

校验顺序：

| 序 | 校验项 | 失败文本要点 |
| --- | --- | --- |
| 1 | 请求体不超过 32 MiB | 导入文件超过 32 MB |
| 2 | `payload` 是对象，`version` 为 1 或 2 | 导入文件的 version 为 <值>，允许 1 或 2 |
| 3 | `fileName` 为非空字符串，不超过 200 字 | 文件名不合法 |
| 4 | `version` 为 1 时按 3.6 节补齐 | 同 3.6 |
| 5 | 按 3.5 节第 3 至 14 条全量校验 | 第 <n> 条待办的 <字段> <原因> |
| 6 | 条目总数不超过 20000 | 条目数超过 20000 |

写入流程：

1. 校验通过后，把当前文件字节复制到数据目录内的 `todos.before-import-<时间戳>.json`，时间戳形如 `20261103-173012`。
2. 复制失败时中止导入，返回 500，`error` 为「导入前备份失败: <绝对路径>，<原因>」，主文件不变。
3. 复制成功后写入导入内容，`version` 写 2，`meta` 保持导入文件取值；主文件原有取值全部被替换。
4. 写入失败时删除本次临时文件，主文件保持导入前内容与修改时间。

响应 `value`：

```json
{ "importedCount": 5, "fromVersion": 2, "backupFile": "todos.before-import-20261103-173012.json" }
```

### 5.8 `POST /import/undo`

请求：`{ backupFile: string }`

规则：

1. `backupFile` 必须匹配 `todos.before-import-<八位日期>-<六位时刻>.json`，且解析后的绝对路径位于数据目录内，否则返回 400「备份文件名不合法」。
2. 备份文件不存在时返回 400「备份文件不存在: <绝对路径>」，主文件不变。
3. 备份内容按 3.5 节校验，校验不通过返回 400「备份文件内容不合法: <失败位置>」，主文件不变。
4. 校验通过后原子写回主文件，响应 `value` 为 `{ "restoredCount": 5, "restoredAt": "2026-11-03T09:30:12.000Z" }`。

### 5.9 `POST /upgrade`

请求：`{ confirm: true }`

规则：

1. 缺少 `confirm: true` 返回 400。
2. 读取文件。`version` 为 2 返回 400「数据已经是 2.0 格式」；`version` 不为 1 返回 500，错误同 3.5 节第 2 条。
3. 把原文件字节复制到数据目录内的 `todos.v1-<时间戳>.json`，时间戳形如 `20261103-173012`；复制失败返回 500「升级前备份失败: <绝对路径>，<原因>」，主文件不变。
4. 按 3.6 节补齐字段，`version` 写 2，`meta` 写 `{ upgradedAt: <当前时刻>, upgradedFrom: 1 }`。
5. 补齐结果按 3.5 节校验，通过后原子写入；校验失败返回 500，主文件不变。
6. 响应 `value`：`{ "upgradedCount": 128, "backupFile": "todos.v1-20261103-173012.json", "fromVersion": 1, "toVersion": 2 }`。

### 5.10 `GET /pending`

查询参数：`sessionId`，必填。

响应 `value`：

```json
{
  "sessionId": "s_7c31",
  "count": 1,
  "items": [
    {
      "entryId": "call_9f2b",
      "entryType": "question",
      "title": "要不要现在发布？",
      "description": "要不要现在发布？",
      "workspaceId": null,
      "quadrant": "urgent-important",
      "createdAt": "2026-11-03T13:40:02.000Z"
    }
  ]
}
```

`items` 来自 Host 进程内存，记录的是本会话当前正在等待用户确认的提问与审批。Host 通过 `user-questions/request` 与 `approval/request` 两个瀑布事件登记条目，两个监听只观察并转交 `next()`，不认领请求，也不改变答案；请求完成后立即移除登记。因此该路由不需要写入队列，也不读写数据文件。`entryId` 取提问的 `wait.callId` 或审批的 `callId`，缺失时使用进程内序号。`entryType` 取 `question` 或 `approval`，与 `/fromConversation` 的 `entryType` 同义，界面用该字段区分来源。缺少 `sessionId` 返回 400；数据文件为版本 1 时本路由照常返回，因为待确认事项与数据文件无关。

## 6. 重复实例

### 6.1 生成位置

只在 `POST /complete` 中生成一条下一条实例。撤销、编辑、改象限、导入、`/duplicateRecurrence` 都不生成。

### 6.2 计划截止时间推进

记 `base` 为已完成条目的 `dueAt`；`base` 为空时取完成时刻，取整到分钟。记 `rule` 为该条的 `recurrence`，`k` 为 `rule.interval`。

| 频率 | 推进方式 |
| --- | --- |
| `daily` | 本地日期加 `k` 天，保留时与分 |
| `weekly` | 本地日期加 `7 × k` 天，保留时与分 |
| `monthly` | 本地年月加 `k` 个月，日取 `base` 的日；超出当月天数时取当月最后一天，保留时与分 |

结果按本机时区序列化为带时区标识的 ISO 8601。跨夏令时的地区按新日期当天的时区标识写入。

示例（`base` 为 2026-01-31 09:00，`monthly`，`interval` 为 1）：

| 完成次序 | 下一条的计划截止时间 |
| --- | --- |
| 第 1 次 | 2026-02-28 09:00 |
| 第 2 次 | 2026-03-31 09:00 |
| 第 3 次 | 2026-04-30 09:00 |

### 6.3 新实例的字段

| 字段 | 取值 |
| --- | --- |
| `title`、`description`、`quadrant`、`workspaceId` | 复制已完成条目 |
| `tags`、`recurrence`、`reminder` | 复制已完成条目；`reminder.snoozeUntil` 置为 `null` |
| `dueAt` | 按 6.2 节计算 |
| `status` | `open` |
| `createdAt` | 当前时刻 |
| `completedAt` | `null` |
| `parentId` | `null` |
| `source` | `{ "kind": "manual" }` |
| `sourceKey` | `null` |
| `seriesId` | 与该链一致；链首本次分配 |
| `generatedFromId` | 已完成条目的 `id` |
| `remindedAt` | `null` |
| `startedSessionId`、`startedAt` | `null` |
| 子待办 | 复制全部子待办的 `title`，`status` 为 `open`，`completedAt` 与 `dueAt` 为 `null`，`createdAt` 为当前时刻，其余字段取 3.2 节的子待办恒定值 |

### 6.4 终止与去重

| 情形 | 处理 |
| --- | --- |
| `until` 为空 | 一直生成 |
| 下一条的计划截止时间晚于 `until` | 不生成，把已完成条目的 `recurrence` 置为 `null` |
| 下一条的计划截止时间等于 `until` | 生成，此后该条完成时不再生成 |
| 同一 `seriesId` 与同一 `dueAt` 已存在 | 不生成 |
| 同一条目重复提交完成 | 状态已为 `done`，直接跳过，不生成 |
| 撤销后再次完成 | 下一条已存在，按去重规则跳过 |
| 已完成记录达到 20000 条 | 本次完成照常生效并写入，不生成下一条，响应 400 并提示导出与清理 |

## 7. 提醒

### 7.1 判定

Host 定时器每 30 秒执行一次，对每个条目按下列顺序判定，命中即写 `remindedAt` 为当前时刻：

1. `status` 为 `open`。
2. `parentId` 为 `null`。
3. `dueAt` 非空。
4. `reminder` 非空。
5. `remindedAt` 为空。
6. 当前时刻不早于 `Date.parse(dueAt) - leadMinutes × 60000`，且当前时刻不早于 `reminder.snoozeUntil`（为空时按 0 处理）。

### 7.2 只提醒一次

`remindedAt` 非空即视为已提醒，定时器跳过。清除 `remindedAt` 的四个入口：`dueAt` 变化、`reminder` 变化、`POST /snooze`、`POST /reopen`。提醒过期不补记，DSH 关闭多日后启动时，只要符合 7.1 节全部条件即在 30 秒内补发一次。

### 7.3 写入失败

定时器写入失败时不修改内存中的条目，不写 `remindedAt`，在控制台打印 `[dsh-todo-center] reminder: <原因>`，等下一次扫描重试。界面上该条仍为未提醒。

### 7.4 定时器的生命周期

定时器随插件 `apply` 建立，随 `ctx.effect` 的处置函数清除。间隔为 30000 毫秒，首次扫描在启动后 5 秒执行。定时器与写队列共用同一条 Promise 队列，不与写请求交错。

## 8. 筛选预设与统计口径

### 8.1 预设

规则见 3.3 与 5.4、5.5。Host 只负责存取，匹配由客户端完成。

### 8.2 统计

统计不提供路由，由客户端用 `GET /snapshot` 的 `todos` 计算。Host 保证快照包含计算所需的全部字段：`status`、`createdAt`、`completedAt`、`dueAt`、`quadrant`、`parentId`、`tags`。计算口径以 `docs/PRD-v2.md` F6 与 5.1、5.2 节为准。

### 8.3 今日视图

今日视图分区由客户端用 `GET /snapshot` 计算，分区口径以 `docs/PRD-v2.md` F2 第 3 条为准。Host 不做分区。

## 9. 上限

| 项 | 上限 | 超限行为 |
| --- | --- | --- |
| 条目总数（含子待办） | 20000 | 导入返回 400；日常创建不设硬性上限，界面提示导出备份 |
| 单条标题 | 200 字 | 400 |
| 单条描述 | 20000 字 | 400 |
| 单条标签数 | 10 | 400 |
| 单个标签长度 | 20 字 | 400 |
| 筛选预设数 | 20 | 400 |
| 预设名称 | 40 字 | 400 |
| 搜索关键词 | 100 字 | 400 |
| 重复间隔 | 12 | 400 |
| 导入请求体 | 32 MiB | 400 |
| 备份文件名 | 200 字 | 400 |
| 数据文件体积 | 无硬性上限 | 超过 30 MiB 时界面提示导出备份并清理已完成条目 |

## 10. 接口层验收

每条用例在 `tests/host-rules/` 下新建的 `verify-api-v2.mjs` 内实现，与既有 `verify-host-rules.mjs` 的 39 条并存。数据目录用临时目录，用例结束后删除。表格中的编号与 `docs/PRD-v2.md` 第 7 节的验收编号对应关系写在最后一列。

| 编号 | 操作 | 期望证据 | 对应验收 |
| --- | --- | --- | --- |
| A2-01 | 放入版本 1 文件后 `GET /snapshot` | 200，`dataVersion` 为 1，`readOnly` 为 true，每条条目含八个新字段且取缺省值，文件字节不变 | 70 |
| A2-02 | 版本 1 状态下 `POST /create` | 400，`error` 为「数据格式为 1.0，请先升级」，文件字节不变 | 70 |
| A2-03 | 版本 1 状态下 `POST /upgrade { confirm: true }` | 200，数据目录出现 `todos.v1-*.json` 且字节与原文件相同；主文件 `version` 为 2，`meta.upgradedFrom` 为 1，条目取值逐条不变；随后 `POST /create` 返回 200 | 71 |
| A2-04 | 版本 2 状态下 `POST /upgrade` | 400，`error` 为「数据已经是 2.0 格式」，文件不变 | 71 |
| A2-05 | 把 `version` 改为 3 后 `GET /snapshot` | 500，`error` 含绝对路径、实际值 3、允许值 1 或 2；文件字节与修改时间不变 | 72 |
| A2-06 | 连续两次 `POST /create` 后 `GET /snapshot` | 两条都在，`todos` 长度为 2 | — |
| A2-07 | `POST /create` 带 11 个标签、21 字标签、含换行的标签 | 分别返回 400，`error` 指明标签数量或长度 | 54 |
| A2-08 | `POST /create` 带重复标签 `["报告","报告"]` | 200，文件内该条 `tags` 为 `["报告"]` | 54 |
| A2-09 | 创建带 `recurrence` 的子待办 | 400，`error` 为「子待办不支持重复设置」 | 51 |
| A2-10 | 创建带 `recurrence` 的会话来源条目 | 400，`error` 为「会话来源的待办不支持重复设置」 | — |
| A2-11 | 创建按天重复（`dueAt` 明日 09:00）、完成后检查文件 | 已完成条目与新条目共享同一 `seriesId`，新条目 `generatedFromId` 等于原条 `id`，`dueAt` 为后天 09:00，`status` 为 `open` | 50 |
| A2-12 | 撤销后再次完成同一条 | 文件内同 `seriesId` 的条目数不变，没有同 `dueAt` 的第二条 | 50、53 |
| A2-13 | 按月重复基准 2026-01-31 09:00 连续完成三次 | 三次新条目的本地日期依次为 02-28、03-31、04-30 | 52 |
| A2-14 | `until` 等于下一条计划截止时间的链完成该条 | 不生成新条目，已完成条目 `recurrence` 为 `null` | 53 |
| A2-15 | 完成带两条子待办的重复条目 | 新条目下出现两条子待办，`title` 相同，`status` 为 `open`，`completedAt` 为 `null` | 50 |
| A2-16 | `dueAt` 改为新时间后检查文件 | 该条 `remindedAt` 为 `null` | 49 |
| A2-17 | 定时器扫描命中后 `GET /reminders` | 200，`count` 为 1，`items[0].id` 与命中条目一致；再扫描一次 `remindedAt` 不变 | 46 |
| A2-18 | `POST /snooze { id, minutes: 10 }` | 200，文件内 `reminder.snoozeUntil` 为当前时刻加 10 分钟，`remindedAt` 为 `null`，`GET /reminders` 的 `count` 为 0 | 48 |
| A2-19 | 完成已提醒条目后 `GET /reminders` | `count` 为 0 | 47 |
| A2-20 | `POST /filterSave` 新建、更新、重名、第 21 条 | 依次为 200、200 且 `updatedAt` 变化、400 重名、400 上限 | 55、57 |
| A2-21 | `POST /filterRemove` 删除不存在的标识 | 400 | 57 |
| A2-22 | `GET /export` 后与文件字节比对字段 | `version` 为 2，六段齐全，`todos` 条数与文件一致 | 65 |
| A2-23 | 八类非法 `POST /import` | 全部 400，`error` 含条目序号或字段名，主文件哈希不变 | 66 |
| A2-24 | 合法 `POST /import` 后 `POST /import/undo` | 导入返回 200 且数据目录出现 `todos.before-import-*.json`；撤销后条数与导入前一致 | 67 |
| A2-25 | `POST /import` 版本 1 文件 | 200，主文件 `version` 为 2，新字段取缺省值 | 68 |
| A2-26 | `POST /import` 零条文件 | 200，`importedCount` 为 0，主文件 `todos` 为空数组 | 69 |
| A2-27 | `POST /import/undo` 指向数据目录外的路径 | 400「备份文件名不合法」，主文件不变 | 67 |
| A2-28 | 把数据目录设为只读后 `POST /import` | 500，`error` 含「导入前备份失败」与路径，主文件哈希不变 | 66 |
| A2-29 | 8 个并发 `GET /snapshot` 在文件不存在时 | 全部 200，文件可解析 | — |
| A2-30 | 写请求缺 `x-dsh-todo` 头 | 403，文件不变 | — |
| A2-31 | `GET /pending` 不带 `sessionId` | 400，`error` 含 `sessionId` | — |
| A2-32 | 触发一次提问请求，在等待期间与请求结束后各查一次 `GET /pending?sessionId=` | 等待期间 `count` 为 1，`items[0].entryType` 为 `question`，`entryId` 取 `wait.callId`；请求结束后 `count` 为 0 | — |

`tests/host-rules/audit-static.mjs` 检查代码与文档的字词规则、类名与样式一致、组件引用完整、插槽注册齐全、客户端路径都在路由表内。`tests/host-rules/check-client-load.mjs` 在 3080 上的真实页面里刷新后检查侧栏入口、样式表数量、四个页签顺序、快速录入条与四个方格，并确认没有未捕获异常。

## 11. 与 v1.1 的兼容

| 场景 | 行为 |
| --- | --- |
| 1.x 客户端连到 2.0 Host | `/snapshot` 的 `dataVersion` 为 2，1.x 客户端忽略该字段，按 `todos` 读取未完成与已完成条目；`/complete` 仍返回 `WriteResult`，1.x 客户端按 `id` 覆盖，新建的重复实例出现在列表里 |
| 2.0 客户端连到 1.x Host | `/snapshot` 缺 `filters`、`settings`、`meta`，客户端按 3.4 节缺省值补齐；版本 1 文件由 1.x Host 正常读写，2.0 的升级横幅不出现 |
| 降级 | 把 `todos.v1-<时间戳>.json` 复制为 `todos.json`；1.x 只认 `version` 为 1，降级后可以正常读取 |

## 12. 与其余两份 2.0 文档的接口边界

| 事项 | 承载位置 |
| --- | --- |
| 提醒的界面承载（侧栏标记、今日页提醒区）与系统通知能力 | `docs/architecture-v2.md`；本文只固定 `/reminders` 的返回结构与定时器节奏 |
| 会话待确认事项的采集与操作条排版 | `docs/architecture-v2.md` 与 `docs/ui-spec-v2.md`；本文只固定 `/pending` 的查询参数与返回结构 |
| 发起会话所需的平台接口（新建会话、发送首条消息） | `docs/architecture-v2.md`；本文只固定 `startedSessionId` 与 `startedAt` 两个可写字段 |
| 快速录入的解析规则与预览区 | 客户端实现，规则见 `docs/PRD-v2.md` F1；本文只固定写入时使用 `POST /create` 与 `tags` 字段 |
| 今日视图分区与统计口径 | 客户端计算，口径见 `docs/PRD-v2.md` F2、F6；本文固定快照必须提供的字段 |
| 标签筛选控件的布局与交互 | `docs/ui-spec-v2.md`；本文固定 `FilterConditions` 的字段与取值范围 |
