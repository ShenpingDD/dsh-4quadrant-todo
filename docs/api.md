# 待办中心接口规格

Host 半与 Client 半的唯一交互面。两侧都以此文件为准，任何一侧改动字段名必须同步改本文件。

## 1. 传输

Host 半在 `webServer` 上注册 `exact` 路由，前缀 `/plugins/dsh-todo-center`。

读请求：`GET`，无请求头要求。

写请求：`POST`，必须带请求头 `content-type: application/json` 与 `x-dsh-todo: 1`。缺少 `x-dsh-todo` 时返回 403。

响应体统一为：

```json
{ "ok": true, "value": { } }
```

```json
{ "ok": false, "error": "可直接展示给用户的错误原因" }
```

状态码：读请求与写请求成功为 200；请求内容不合法为 400；缺少写入标记为 403；数据文件不可读或不可写为 500。

## 2. 数据文件

路径：`join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'todo-center', 'todos.json')`。

文件结构：

```json
{
  "version": 1,
  "todos": [],
  "collapsed": {}
}
```

`collapsed` 为 `{ [scopeKey]: { [quadrant]: boolean } }`，`scopeKey` 取工作区标识或 `all`。

读取规则：文件不存在时创建空结构并返回；`version` 不等于 1、JSON 解析失败、结构校验不通过时抛错，响应为 500，错误文本包含文件绝对路径与失败原因。不自动迁移，不覆盖该文件。

写入规则：写入同目录下的 `todos.json.tmp`，再用重命名覆盖正式文件。写入失败抛错，响应为 500，错误文本包含路径。

## 3. 数据模型

```ts
type Quadrant = 'urgent-important' | 'urgent-not-important' | 'not-urgent-important' | 'not-urgent-not-important'

interface TodoSource {
  kind: 'manual' | 'conversation'
  sessionId?: string
  entryId?: string
  entryType?: 'question' | 'approval'
}

interface TodoItem {
  id: string              // 形如 t_<uuid>
  title: string           // 1..200，已去除首尾空白
  description: string     // 0..20000，可为空字符串
  quadrant: Quadrant
  dueAt: string | null    // ISO 8601 带时区标识，精确到分钟
  parentId: string | null
  status: 'open' | 'done'
  createdAt: string       // ISO 8601，等于开始时间
  completedAt: string | null
  workspaceId: string | null
  source: TodoSource
  sourceKey: string | null // `${sessionId}:${entryId}:${entryType}`，仅 conversation 来源有值
}

interface WriteResult {
  upserted: TodoItem[]     // 新增或被修改的条目，客户端按 id 覆盖
  removedIds: string[]     // 被删除的条目
}
```

时间一律用 `new Date().toISOString()` 生成，客户端负责按本机时区显示。

## 4. 路由

### 4.1 `GET /snapshot`

响应 `value`：

```json
{ "version": 1, "todos": [], "collapsed": {} }
```

`todos` 含顶层待办与子待办，顺序不保证。

### 4.2 `POST /create`

请求：`{ title, description?, dueAt?, quadrant, parentId?, workspaceId?, source? }`

`source` 省略时为 `{ "kind": "manual" }`。

规则：标题去除首尾空白后不得为空且不超过 200 字；描述缺省为空字符串，不超过 20000 字；`parentId` 有值时必须指向存在的顶层待办，并且不产生第二层；子待办的 `quadrant` 取父任务的象限，忽略请求中的取值；子待办的 `workspaceId` 与 `source` 取父任务的值。

响应 `value`：`WriteResult & { focusId: string }`，`focusId` 为新建条目的标识。

### 4.3 `POST /update`

请求：`{ id, title?, description?, dueAt? }`

只允许改这三个字段。`dueAt: null` 表示清空。校验规则同创建。改父任务的计划截止时间不影响子待办。

响应 `value`：`WriteResult`。

### 4.4 `POST /complete`

请求：`{ ids: string[], includeChildren: boolean }`

规则：

1. 已经完成的条目跳过。
2. 条目存在未完成的子待办时：`includeChildren` 为 false 抛错「存在未完成的子待办，需确认合并完成」；为 true 时父任务与全部子待办使用同一个 `completedAt` 一并完成。
3. 完成的是子待办时，若其父任务的全部子待办都已完成为真，父任务自动完成，父任务的 `completedAt` 取最后完成的那个子待办的 `completedAt`。
4. 自动完成只在子待办由 `open` 变 `done` 的那一刻发生。

响应 `value`：`WriteResult`。

### 4.5 `POST /reopen`

请求：`{ ids: string[] }`

规则：状态回到 `open`，`completedAt` 清空。父任务撤销不改变任何一个子待办的完成状态，也不触发再次自动完成。

响应 `value`：`WriteResult`。

### 4.6 `POST /remove`

请求：`{ ids: string[] }`

规则：删除条目及其全部子待办。不存在的标识忽略。

响应 `value`：`WriteResult`。

### 4.7 `POST /setQuadrant`

请求：`{ ids: string[], quadrant: Quadrant }`

规则：顶层待办改象限时其全部子待办一并改；子待办单独收到该请求时忽略，不报错。

响应 `value`：`WriteResult`。

### 4.8 `POST /setCollapsed`

请求：`{ scopeKey: string, quadrant: Quadrant, collapsed: boolean }`

响应 `value`：`{ "collapsed": { } }`，返回写入后的完整 `collapsed`。

### 4.9 `POST /fromConversation`

请求：`{ sessionId, entryType, entryId, title, description, quadrant?, workspaceId?, dueAt? }`

规则：以 `sourceKey` 去重。已存在同 `sourceKey` 的条目时不新建，返回该条目的标识。新建时 `source` 为 `{ kind: 'conversation', sessionId, entryId, entryType }`，`sourceKey` 按第 3 节拼接；标题与描述做与创建相同的校验；`quadrant` 缺省为 `urgent-important`。

响应 `value`：`WriteResult & { focusId: string, existing: boolean }`。

## 5. Host 侧结构要求

`lib/index.js` 导出 `apply(ctx, config)`，声明 `export const inject = ['webServer']`。

`config` 支持一个可选字段 `dataDir`，用于覆盖默认的数据目录；缺省时按第 2 节计算。

全部写操作串行执行：用一个 Promise 链排队，避免并发请求互相覆盖。

路由注册全部包在 `ctx.effect` 内，返回处置函数。

错误统一在包装函数里捕获，打印 `[dsh-todo-center] <url>: <message>`，并在响应未发出时返回对应状态码；已发出时直接结束响应。

## 6. Client 侧调用方式

```js
const ROUTE = '/plugins/dsh-todo-center'
const headers = { 'content-type': 'application/json', 'x-dsh-todo': '1' }

async function call(path, options) {
  const response = await fetch(`${ROUTE}${path}`, options)
  const payload = await response.json()
  if (payload.ok !== true) throw new Error(payload.error ?? `请求失败 ${response.status}`)
  return payload.value
}
```

客户端维护一份 `todos` 与 `collapsed` 的本地副本，写操作成功后用 `upserted` 与 `removedIds` 合并，不做全量重拉。
