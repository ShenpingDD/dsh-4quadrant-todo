// Host 半规则验证：父子联动、来源去重、版本与结构校验
// 直接加载 lib/index.js 的 apply，用真实 node:http 服务与真实文件系统驱动，
// 数据目录通过 config.dataDir 指向本目录下的 .run，不触碰 %DSH_HOME%。

import { createServer } from 'node:http'
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../../lib/index.js'

const PREFIX = '/plugins/dsh-4quadrant-todo'
const here = path.dirname(fileURLToPath(import.meta.url))
const runRoot = path.join(here, '.run')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const dataDir = path.join(runRoot, `run-${stamp}`)
const dataFile = path.join(dataDir, 'todos.json')
const tempFile = path.join(dataDir, 'todos.json.tmp')

await fsp.mkdir(dataDir, { recursive: true })

// ---------- 用真实 lib/index.js 启动 ----------

const handlers = new Map()
const timers = []

const webServer = {
  register(route) {
    if (route.kind !== 'exact') throw new Error(`本验证脚本只支持 exact 路由: ${route.kind}`)
    if (handlers.has(route.path)) throw new Error(`路由重复注册: ${route.path}`)
    handlers.set(route.path, route.handler)
    return () => {
      handlers.delete(route.path)
    }
  }
}

const timer = {
  interval(callback, delay) {
    timers.push({ kind: 'interval', callback, delay })
    return () => {}
  },
  timeout(callback, delay) {
    timers.push({ kind: 'timeout', callback, delay })
    return () => {}
  }
}

const ctx = {
  get(serviceName) {
    if (serviceName === 'webServer') return webServer
    if (serviceName === 'timer') return timer
    return undefined
  },
  effect(fn) {
    return fn()
  },
  on() {
    return () => {}
  }
}

apply(ctx, { dataDir })

if (handlers.size !== 26) throw new Error(`路由数量应为 26，实际 ${handlers.size}`)

const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  const handler = handlers.get(pathname)
  if (handler === undefined) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: `路由不存在: ${pathname}` }))
    return
  }
  Promise.resolve(handler(req, res)).catch((error) => {
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: String(error) }))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}${PREFIX}`

// ---------- 请求与文件工具 ----------

async function request(method, suffix, options = {}) {
  const response = await fetch(`${base}${suffix}`, {
    method,
    headers: options.headers,
    body: options.body
  })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = { ok: false, error: `响应不是 JSON: ${text.slice(0, 120)}` }
  }
  return { status: response.status, payload }
}

function postJson(suffix, body) {
  return request('POST', suffix, {
    headers: { 'content-type': 'application/json', 'x-dsh-todo': '1' },
    body: JSON.stringify(body)
  })
}

async function resetData() {
  await fsp.rm(dataFile, { force: true })
  await fsp.rm(tempFile, { recursive: true, force: true })
  for (const name of await fsp.readdir(dataDir)) {
    if (name.startsWith('todos.json.') && name.endsWith('.tmp')) {
      await fsp.rm(path.join(dataDir, name), { recursive: true, force: true })
    }
  }
}

async function writeDataText(text) {
  await fsp.writeFile(dataFile, text, 'utf8')
}

async function readDataJson() {
  return JSON.parse(await fsp.readFile(dataFile, 'utf8'))
}

async function fileHash() {
  return createHash('sha256').update(await fsp.readFile(dataFile)).digest('hex')
}

async function snapshotTodos() {
  const { status, payload } = await request('GET', '/snapshot')
  if (status !== 200 || payload.ok !== true) throw new Error(`快照读取失败 status=${status} error=${payload.error}`)
  return payload.value.todos
}

async function lastWriteTimeOf(id) {
  const todos = await snapshotTodos()
  const found = todos.find((item) => item.id === id)
  if (found === undefined) throw new Error(`待办不存在: ${id}`)
  return found
}

async function createTop(input) {
  const { status, payload } = await postJson('/create', input)
  if (status !== 200 || payload.ok !== true) throw new Error(`建顶层待办失败 status=${status} error=${payload.error}`)
  return payload.value.focusId
}

async function createChild(parentId, title, extra = {}) {
  const { status, payload } = await postJson('/create', { title, parentId, ...extra })
  if (status !== 200 || payload.ok !== true) throw new Error(`建子待办失败 status=${status} error=${payload.error}`)
  return payload.value.focusId
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------- 结果记录 ----------

const results = []

async function probe(id, kind, clause, description, expected, run) {
  const outcome = await run()
  results.push({
    id,
    kind,
    clause,
    description,
    expected,
    actual: outcome.text,
    pass: outcome.pass === true,
    verdict: outcome.verdict ?? null
  })
}

function expectError(response, status, needle) {
  const message = String(response.payload.error ?? JSON.stringify(response.payload))
  return {
    pass: response.status === status && message.includes(needle),
    text: `status=${response.status} error=${message}`
  }
}

function fixtureTodo(overrides = {}) {
  return {
    id: 't_fixture',
    title: '结构校验样例',
    description: '',
    quadrant: 'urgent-important',
    dueAt: null,
    parentId: null,
    status: 'open',
    createdAt: '2026-11-03T08:00:00.000Z',
    completedAt: null,
    workspaceId: null,
    source: { kind: 'manual' },
    sourceKey: null,
    tags: [],
    recurrence: null,
    seriesId: null,
    generatedFromId: null,
    reminder: null,
    remindedAt: null,
    startedSessionId: null,
    startedAt: null,
    ...overrides
  }
}

function fixtureDocument(overrides = {}) {
  return {
    version: 2,
    todos: [],
    collapsed: {},
    filters: [],
    settings: { reminderLeadMinutes: 30, statsRange: 'week' },
    meta: { upgradedAt: null, upgradedFrom: null },
    ...overrides
  }
}

// ---------- A. 父子联动 ----------

await resetData()

await probe('A1', 'requirement', 'PRD 8.1、api.md 4.2', '子待办继承父任务的象限、工作区标识与来源，忽略请求里的象限与工作区',
  'child.quadrant 与 child.workspaceId 等于父任务取值', async () => {
    const parentId = await createTop({
      title: '父任务 A1',
      quadrant: 'not-urgent-important',
      workspaceId: 'ws-alpha',
      source: { kind: 'manual' }
    })
    const { status, payload } = await postJson('/create', {
      title: '子任务 A1',
      parentId,
      quadrant: 'urgent-important',
      workspaceId: 'ws-other'
    })
    if (status !== 200) return { pass: false, text: `status=${status} error=${payload.error}` }
    const childId = payload.value.focusId
    const parent = await lastWriteTimeOf(parentId)
    const child = await lastWriteTimeOf(childId)
    return {
      pass: child.parentId === parentId && child.quadrant === parent.quadrant && child.workspaceId === parent.workspaceId,
      text: `child.parentId=${child.parentId} child.quadrant=${child.quadrant} child.workspaceId=${child.workspaceId} parent.quadrant=${parent.quadrant} parent.workspaceId=${parent.workspaceId}`
    }
  })

await probe('A2', 'requirement', 'PRD 8.2 规则 2、验收 9', '存在未完成子待办时 includeChildren=false 必须报错且不改动文件',
  'status=400 且错误含「存在未完成的子待办」，文件哈希不变', async () => {
    const parentId = await createTop({ title: '父任务 A2', quadrant: 'urgent-important' })
    await createChild(parentId, '子任务 A2-1')
    await createChild(parentId, '子任务 A2-2')
    const before = await fileHash()
    const response = await postJson('/complete', { ids: [parentId], includeChildren: false })
    const after = await fileHash()
    const outcome = expectError(response, 400, '存在未完成的子待办')
    return { pass: outcome.pass && before === after, text: `${outcome.text} 文件哈希不变=${before === after}` }
  })

await probe('A3', 'requirement', 'PRD 8.2 规则 2、验收 9', 'includeChildren=true 时父任务与全部子待办一并完成且完成时间相同',
  '三条都是 done，三条 completedAt 完全相同', async () => {
    const todos = await snapshotTodos()
    const parent = todos.find((item) => item.title === '父任务 A2')
    const children = todos.filter((item) => item.parentId === parent.id)
    const response = await postJson('/complete', { ids: [parent.id], includeChildren: true })
    if (response.status !== 200) return { pass: false, text: `status=${response.status} error=${response.payload.error}` }
    const updated = await snapshotTodos()
    const group = updated.filter((item) => item.id === parent.id || item.parentId === parent.id)
    const allDone = group.every((item) => item.status === 'done')
    const times = new Set(group.map((item) => item.completedAt))
    return {
      pass: allDone && times.size === 1 && group.length === 3,
      text: `条数=${group.length} 全部完成=${allDone} completedAt 取值数=${times.size} 子待办数=${children.length}`
    }
  })

await probe('A4', 'requirement', 'PRD 8.2 规则 3、验收 10', '最后一个子待办完成时父任务自动完成，父任务完成时间等于该子待办的完成时间',
  '父任务 done 且 parent.completedAt === lastChild.completedAt', async () => {
    const parentId = await createTop({ title: '父任务 A4', quadrant: 'not-urgent-not-important' })
    const first = await createChild(parentId, '子任务 A4-1')
    const second = await createChild(parentId, '子任务 A4-2')
    await postJson('/complete', { ids: [first], includeChildren: false })
    const afterFirst = await lastWriteTimeOf(parentId)
    await sleep(15)
    await postJson('/complete', { ids: [second], includeChildren: false })
    const parent = await lastWriteTimeOf(parentId)
    const lastChild = await lastWriteTimeOf(second)
    return {
      pass: afterFirst.status === 'open' && afterFirst.completedAt === null && parent.status === 'done' && parent.completedAt === lastChild.completedAt,
      text: `首个完成后父=${afterFirst.status}/${afterFirst.completedAt} 末个完成后父=${parent.status}/${parent.completedAt} 子=${lastChild.completedAt}`
    }
  })

await probe('A5', 'requirement', 'PRD 8.2 规则 4、验收 11', '撤销父任务完成后，即使全部子待办仍已完成，父任务不再自动完成',
  '父任务保持 open，两个子待办仍为 done', async () => {
    const todos = await snapshotTodos()
    const parent = todos.find((item) => item.title === '父任务 A4')
    const children = todos.filter((item) => item.parentId === parent.id)
    await postJson('/reopen', { ids: [parent.id] })
    const afterReopen = await lastWriteTimeOf(parent.id)
    const doneChild = children.find((item) => item.status === 'done')
    await postJson('/complete', { ids: [doneChild.id], includeChildren: false })
    const afterRetry = await lastWriteTimeOf(parent.id)
    const childrenNow = (await snapshotTodos()).filter((item) => item.parentId === parent.id)
    const childrenStayDone = childrenNow.every((item) => item.status === 'done')
    return {
      pass: afterReopen.status === 'open' && afterReopen.completedAt === null && afterRetry.status === 'open' && childrenStayDone,
      text: `撤销后父=${afterReopen.status}/${afterReopen.completedAt} 再完成已完成子后父=${afterRetry.status} 子待办仍完成=${childrenStayDone}`
    }
  })

await probe('A6', 'requirement', 'PRD 8.3、验收 12', '删除顶层待办级联删除全部子待办并回报 removedIds',
  'removedIds 含 3 条，快照中不留残留', async () => {
    const parentId = await createTop({ title: '父任务 A6', quadrant: 'urgent-not-important' })
    const first = await createChild(parentId, '子任务 A6-1')
    const second = await createChild(parentId, '子任务 A6-2')
    const response = await postJson('/remove', { ids: [parentId] })
    if (response.status !== 200) return { pass: false, text: `status=${response.status} error=${response.payload.error}` }
    const removed = response.payload.value.removedIds
    const remaining = (await snapshotTodos()).filter((item) => item.id === parentId || item.parentId === parentId)
    return {
      pass: removed.length === 3 && removed.includes(first) && removed.includes(second) && remaining.length === 0,
      text: `removedIds 条数=${removed.length} 残留=${remaining.length}`
    }
  })

await probe('A7', 'requirement', 'PRD 6.7、8.1', '改顶层待办象限时其子待办象限一并改变',
  '父与两个子待办的 quadrant 同为 urgent-important', async () => {
    const parentId = await createTop({ title: '父任务 A7', quadrant: 'not-urgent-not-important' })
    await createChild(parentId, '子任务 A7-1')
    await createChild(parentId, '子任务 A7-2')
    const response = await postJson('/setQuadrant', { ids: [parentId], quadrant: 'urgent-important' })
    if (response.status !== 200) return { pass: false, text: `status=${response.status} error=${response.payload.error}` }
    const todos = await snapshotTodos()
    const group = todos.filter((item) => item.id === parentId || item.parentId === parentId)
    const allMoved = group.every((item) => item.quadrant === 'urgent-important')
    return { pass: group.length === 3 && allMoved, text: `条数=${group.length} 全部改到目标象限=${allMoved}` }
  })

await probe('A8', 'requirement', 'PRD 8.1、api.md 4.7', '子待办单独收到改象限请求时被忽略且不报错',
  'status=200，子待办象限仍为父任务象限', async () => {
    const todos = await snapshotTodos()
    const parent = todos.find((item) => item.title === '父任务 A7')
    const child = todos.find((item) => item.parentId === parent.id)
    const response = await postJson('/setQuadrant', { ids: [child.id], quadrant: 'urgent-not-important' })
    const after = await lastWriteTimeOf(child.id)
    return {
      pass: response.status === 200 && after.quadrant === parent.quadrant,
      text: `status=${response.status} 子待办象限=${after.quadrant} 父任务象限=${parent.quadrant}`
    }
  })

await probe('A9', 'requirement', 'PRD 8.1', '不允许出现第二层，父待办本身是子待办时必须报错',
  'status=400 且错误含「父待办必须是顶层待办」', async () => {
    const todos = await snapshotTodos()
    const parent = todos.find((item) => item.title === '父任务 A7')
    const child = todos.find((item) => item.parentId === parent.id)
    const response = await postJson('/create', { title: '第二层样例', parentId: child.id, quadrant: 'urgent-important' })
    return expectError(response, 400, '父待办必须是顶层待办')
  })

await probe('A10', 'requirement', 'api.md 4.2', '父待办不存在时创建子待办必须报错',
  'status=400 且错误含「父待办不存在」', async () => {
    const response = await postJson('/create', { title: '孤儿样例', parentId: 't_missing_parent', quadrant: 'urgent-important' })
    return expectError(response, 400, '父待办不存在')
  })

await probe('A11', 'observation', 'PRD 4、8.2 规则 2', '合并完成时是否会覆盖已完成子待办的完成时间',
  '记录实际取值，交产品裁定', async () => {
    const parentId = await createTop({ title: '父任务 A11', quadrant: 'urgent-important' })
    const first = await createChild(parentId, '子任务 A11-1')
    const second = await createChild(parentId, '子任务 A11-2')
    await postJson('/complete', { ids: [first], includeChildren: false })
    const firstBefore = await lastWriteTimeOf(first)
    await sleep(20)
    await postJson('/complete', { ids: [parentId], includeChildren: true })
    const firstAfter = await lastWriteTimeOf(first)
    const overwritten = firstAfter.completedAt !== firstBefore.completedAt
    return {
      pass: true,
      verdict: overwritten ? '待裁定' : '符合',
      text: `子待办完成时间 合并前=${firstBefore.completedAt} 合并后=${firstAfter.completedAt} 被覆盖=${overwritten}`
    }
  })

await probe('A12', 'observation', 'PRD 8.1', '撤销父任务后新加子待办并完成，父任务是否再次自动完成（既有子待办全部完成）',
  '记录实际取值，交产品裁定', async () => {
    const parentId = await createTop({ title: '父任务 A12', quadrant: 'urgent-important' })
    const only = await createChild(parentId, '子任务 A12-1')
    await postJson('/complete', { ids: [only], includeChildren: false })
    await postJson('/reopen', { ids: [parentId] })
    const extra = await createChild(parentId, '子任务 A12-2')
    await postJson('/complete', { ids: [extra], includeChildren: false })
    const parent = await lastWriteTimeOf(parentId)
    return {
      pass: true,
      verdict: '待裁定',
      text: `撤销父任务后新增子待办并完成，父任务状态=${parent.status} completedAt=${parent.completedAt}`
    }
  })

// ---------- B. 来源去重 ----------

await resetData()

const conversationInput = {
  sessionId: 'session-demo-0001',
  entryId: 'call-demo-0001',
  entryType: 'question',
  title: '来自会话的去重样例',
  description: '完整问题文本与全部选项'
}

await probe('B1', 'requirement', 'PRD 10.4、验收 21 与 22', '同一来源条目重复加入返回已存在且不生成第二条',
  '第二次 existing=true 且 focusId 相同，总数不变', async () => {
    const first = await postJson('/fromConversation', conversationInput)
    if (first.status !== 200) return { pass: false, text: `status=${first.status} error=${first.payload.error}` }
    const second = await postJson('/fromConversation', conversationInput)
    const todos = await snapshotTodos()
    const value = second.payload.value ?? {}
    return {
      pass: second.status === 200 && value.existing === true && value.focusId === first.payload.value.focusId && todos.length === 1,
      text: `第二次 status=${second.status} existing=${value.existing} focusId 相同=${value.focusId === first.payload.value.focusId} 总数=${todos.length}`
    }
  })

await probe('B2', 'requirement', 'PRD 7 sourceKey、10.4', 'sourceKey 按「会话标识:来源条目标识:来源类型」拼接',
  'sourceKey 严格等于三段拼接', async () => {
    const todos = await snapshotTodos()
    const target = todos[0]
    const expectedKey = `${conversationInput.sessionId}:${conversationInput.entryId}:${conversationInput.entryType}`
    return {
      pass: target.sourceKey === expectedKey && target.source.kind === 'conversation' && target.source.entryType === 'question',
      text: `sourceKey=${target.sourceKey} source.kind=${target.source.kind}`
    }
  })

await probe('B3', 'requirement', 'PRD 10.3', '来自会话的待办默认进入紧急且重要方格、工作区留空',
  'quadrant=urgent-important 且 workspaceId=null', async () => {
    const todos = await snapshotTodos()
    const target = todos[0]
    return {
      pass: target.quadrant === 'urgent-important' && target.workspaceId === null,
      text: `quadrant=${target.quadrant} workspaceId=${target.workspaceId}`
    }
  })

await probe('B4', 'requirement', 'PRD 10.4', '来源类型不同视为不同条目，不被去重拦截',
  '同一会话与条目标识、entryType 换成 approval 后新建成功，总数 2', async () => {
    const response = await postJson('/fromConversation', { ...conversationInput, entryType: 'approval' })
    const todos = await snapshotTodos()
    const value = response.payload.value ?? {}
    return {
      pass: response.status === 200 && value.existing === false && todos.length === 2,
      text: `status=${response.status} existing=${value.existing} 总数=${todos.length}`
    }
  })

await probe('B5', 'requirement', 'PRD 10.4', '会话不同视为不同条目',
  '换 sessionId 后新建成功，总数 3', async () => {
    const response = await postJson('/fromConversation', { ...conversationInput, sessionId: 'session-demo-0002' })
    const todos = await snapshotTodos()
    const value = response.payload.value ?? {}
    return {
      pass: response.status === 200 && value.existing === false && todos.length === 3,
      text: `status=${response.status} existing=${value.existing} 总数=${todos.length}`
    }
  })

await probe('B6', 'requirement', 'PRD 10.4', '来源待办的子待办不参与去重，重复加入仍命中父任务',
  'existing=true 且 focusId 等于父任务标识，总数不变', async () => {
    const todos = await snapshotTodos()
    const parent = todos.find((item) => item.sourceKey === `${conversationInput.sessionId}:${conversationInput.entryId}:question`)
    const childId = await createChild(parent.id, '来自会话待办的子任务')
    const child = await lastWriteTimeOf(childId)
    const before = (await snapshotTodos()).length
    const response = await postJson('/fromConversation', conversationInput)
    const after = (await snapshotTodos()).length
    const value = response.payload.value ?? {}
    return {
      pass: child.sourceKey === parent.sourceKey && value.existing === true && value.focusId === parent.id && after === before,
      text: `子待办 sourceKey=${child.sourceKey} existing=${value.existing} focusId 命中父任务=${value.focusId === parent.id} 总数 ${before}→${after}`
    }
  })

await probe('B7', 'observation', 'PRD 10.4', '已完成的来源待办是否仍被去重命中',
  '记录实际取值，交产品裁定', async () => {
    const todos = await snapshotTodos()
    const parent = todos.find((item) => item.sourceKey === `${conversationInput.sessionId}:${conversationInput.entryId}:question`)
    await postJson('/complete', { ids: [parent.id], includeChildren: true })
    const response = await postJson('/fromConversation', conversationInput)
    const value = response.payload.value ?? {}
    return {
      pass: true,
      verdict: value.existing === true ? '待裁定' : '符合',
      text: `父任务已完成的情况下再次加入 existing=${value.existing} focusId=${value.focusId}`
    }
  })

await probe('B8', 'observation', 'PRD 10.4', '删除来源待办后再次加入是否新建',
  '记录实际取值，交产品裁定', async () => {
    const todos = await snapshotTodos()
    const parent = todos.find((item) => item.sourceKey === `${conversationInput.sessionId}:${conversationInput.entryId}:question`)
    await postJson('/remove', { ids: [parent.id] })
    const response = await postJson('/fromConversation', conversationInput)
    const value = response.payload.value ?? {}
    return {
      pass: true,
      verdict: value.existing === false ? '待裁定' : '符合',
      text: `删除后再次加入 existing=${value.existing} 新标识=${value.focusId}`
    }
  })

await probe('B9', 'requirement', 'PRD 10.4 去重不变量', '同 sourceKey 的顶层待办在数据文件中最多一条，/create 不得绕过来源去重',
  '服务端拒绝或合并同 sourceKey 的会话来源条目，数据文件中同 sourceKey 只有一条', async () => {
    const response = await postJson('/create', {
      title: '绕过去重的会话来源条目',
      quadrant: 'urgent-important',
      source: {
        kind: 'conversation',
        sessionId: conversationInput.sessionId,
        entryId: conversationInput.entryId,
        entryType: conversationInput.entryType
      }
    })
    const todos = await snapshotTodos()
    const targetKey = `${conversationInput.sessionId}:${conversationInput.entryId}:question`
    const sameKey = todos.filter((item) => item.parentId === null && item.sourceKey === targetKey)
    return {
      pass: response.status !== 200 && sameKey.length === 1,
      text: `status=${response.status} 同 sourceKey 顶层条数=${sameKey.length}`
    }
  })

await probe('B10', 'requirement', 'PRD 7', '手动创建的待办 source.kind=manual 且 sourceKey 为 null',
  'sourceKey=null', async () => {
    await resetData()
    const id = await createTop({ title: '手动来源样例', quadrant: 'not-urgent-important' })
    const todo = await lastWriteTimeOf(id)
    return {
      pass: todo.source.kind === 'manual' && todo.sourceKey === null,
      text: `source.kind=${todo.source.kind} sourceKey=${todo.sourceKey}`
    }
  })

// ---------- C. 版本与结构校验 ----------

await resetData()

await probe('C1', 'requirement', 'PRD 12.3、验收 19', 'version 不认识时报错且不覆盖文件',
  'status=500、错误含文件路径与版本号，文件哈希不变', async () => {
    await writeDataText(JSON.stringify(fixtureDocument({ version: 3 }), null, 2))
    const before = await fileHash()
    const response = await request('GET', '/snapshot')
    const after = await fileHash()
    const message = String(response.payload.error ?? '')
    return {
      pass: response.status === 500 && message.includes(dataFile) && message.includes('版本') && before === after,
      text: `status=${response.status} 含路径=${message.includes(dataFile)} 错误=${message} 文件未改=${before === after}`
    }
  })

await probe('C2', 'requirement', 'PRD 12.3、验收 19', '非法 JSON 时报错且不覆盖文件',
  'status=500、错误含文件路径与解析原因，文件哈希不变', async () => {
    await writeDataText('{ "version": 1, "todos": [ ')
    const before = await fileHash()
    const response = await request('GET', '/snapshot')
    const after = await fileHash()
    const message = String(response.payload.error ?? '')
    return {
      pass: response.status === 500 && message.includes(dataFile) && message.includes('无法解析') && before === after,
      text: `status=${response.status} 含路径=${message.includes(dataFile)} 错误=${message} 文件未改=${before === after}`
    }
  })

await probe('C3', 'requirement', 'PRD 12.2', '顶层不是对象时报错',
  'status=500 且错误含「顶层必须是对象」', async () => {
    await writeDataText(JSON.stringify([], null, 2))
    return expectError(await request('GET', '/snapshot'), 500, '顶层必须是对象')
  })

await probe('C4', 'requirement', 'PRD 12.2', 'todos 不是数组时报错',
  'status=500 且错误含「todos 必须是数组」', async () => {
    await writeDataText(JSON.stringify(fixtureDocument({ todos: {} }), null, 2))
    return expectError(await request('GET', '/snapshot'), 500, 'todos 必须是数组')
  })

await probe('C5', 'requirement', 'PRD 12.2', '待办缺少必需字段时报错并指明序号',
  'status=500 且错误含「第 1 条待办」', async () => {
    const broken = fixtureTodo({ id: 't_broken' })
    delete broken.status
    await writeDataText(JSON.stringify(fixtureDocument({ todos: [broken] }), null, 2))
    return expectError(await request('GET', '/snapshot'), 500, '第 1 条待办')
  })

await probe('C6', 'requirement', 'PRD 12.1', 'collapsed 的分区值不是对象时报错',
  'status=500 且错误含「collapsed.all 必须是对象」', async () => {
    await writeDataText(JSON.stringify(fixtureDocument({ collapsed: { all: [] } }), null, 2))
    return expectError(await request('GET', '/snapshot'), 500, 'collapsed.all 必须是对象')
  })

await probe('C7', 'requirement', 'PRD 12.1', 'collapsed 的象限取值必须是布尔值',
  'status=500 拒绝加载', async () => {
    await writeDataText(JSON.stringify(fixtureDocument({
      collapsed: { all: { 'urgent-important': 'yes', 'urgent-not-important': false, 'not-urgent-important': false, 'not-urgent-not-important': false } }
    }), null, 2))
    const response = await request('GET', '/snapshot')
    return {
      pass: response.status === 500,
      text: `status=${response.status} 错误=${String(response.payload.error ?? '')}`
    }
  })

await probe('C8', 'requirement', 'PRD 7 dueAt', 'dueAt 必须是带时区标识的 ISO 8601 字符串',
  'status=500 拒绝加载非字符串 dueAt', async () => {
    await writeDataText(JSON.stringify(fixtureDocument({ todos: [fixtureTodo({ id: 't_bad_due', dueAt: 123 })] }), null, 2))
    const response = await request('GET', '/snapshot')
    return {
      pass: response.status === 500,
      text: `status=${response.status} 错误=${String(response.payload.error ?? '')}`
    }
  })

await probe('C9', 'requirement', 'PRD 7 id 唯一', '数据文件里的待办标识必须唯一',
  'status=500 拒绝加载重复标识', async () => {
    await writeDataText(JSON.stringify(fixtureDocument({
      todos: [fixtureTodo({ id: 't_dup' }), fixtureTodo({ id: 't_dup', title: '重复标识样例' })]
    }), null, 2))
    const response = await request('GET', '/snapshot')
    return {
      pass: response.status === 500,
      text: `status=${response.status} 错误=${String(response.payload.error ?? '')}`
    }
  })

await probe('C10', 'requirement', 'PRD 7 parentId', 'parentId 必须指向存在的顶层待办',
  'status=500 拒绝加载孤儿子待办', async () => {
    await writeDataText(JSON.stringify(fixtureDocument({
      todos: [
        fixtureTodo({ id: 't_orphan', title: '孤儿子待办', parentId: 't_deleted_parent' })
      ]
    }), null, 2))
    const response = await request('GET', '/snapshot')
    return {
      pass: response.status === 500,
      text: `status=${response.status} 错误=${String(response.payload.error ?? '')}`
    }
  })

await probe('C11', 'requirement', 'api-v2.md 3、PRD-v2 3.3', '文件不存在时创建空结构并返回 version 2',
  'status=200、version=2、文件被建立', async () => {
    await resetData()
    const response = await request('GET', '/snapshot')
    const created = await readDataJson()
    return {
      pass: response.status === 200 && response.payload.value.version === 2 && Array.isArray(created.todos) && created.todos.length === 0,
      text: `status=${response.status} version=${response.payload.value?.version} todos 条数=${created.todos?.length}`
    }
  })

await probe('C12', 'requirement', 'PRD 12.2', '残留的半截临时文件不影响正式文件读取',
  'status=200 且返回正式文件内容', async () => {
    await writeDataText(JSON.stringify(fixtureDocument({ todos: [fixtureTodo({ id: 't_keep', title: '正式文件里的条目' })] }), null, 2))
    await fsp.writeFile(tempFile, '{ 半截', 'utf8')
    const response = await request('GET', '/snapshot')
    return {
      pass: response.status === 200 && response.payload.value.todos.length === 1 && response.payload.value.todos[0].id === 't_keep',
      text: `status=${response.status} 条数=${response.payload.value?.todos?.length}`
    }
  })

await probe('C13', 'observation', 'PRD 12.2', '文件不存在时并发首次读取是否稳定',
  '记录 40 轮、每轮 8 个并发读取的非 200 次数与最终文件可解析性', async () => {
    let nonOk = 0
    let unparsable = 0
    const samples = []
    for (let round = 0; round < 40; round += 1) {
      await resetData()
      const responses = await Promise.all(Array.from({ length: 8 }, () => request('GET', '/snapshot')))
      for (const response of responses) {
        if (response.status !== 200) {
          nonOk += 1
          if (samples.length < 3) samples.push(`status=${response.status} ${String(response.payload.error ?? '')}`)
        }
      }
      try {
        await readDataJson()
      } catch {
        unparsable += 1
      }
    }
    return {
      pass: true,
      verdict: nonOk === 0 && unparsable === 0 ? '符合' : '风险',
      text: `并发读取合计 320 次，非 200 次数=${nonOk}，文件不可解析轮数=${unparsable}${samples.length === 0 ? '' : `，样例：${samples.join(' | ')}`}`
    }
  })

await probe('C14', 'requirement', 'PRD 12.2、api.md 5', '全部写操作串行执行，并发写入不互相覆盖',
  '10 个并发创建全部成功，数据文件含 10 条', async () => {
    await resetData()
    const responses = await Promise.all(Array.from({ length: 10 }, (unused, index) => postJson('/create', {
      title: `并发写入样例 ${index + 1}`,
      quadrant: 'urgent-important'
    })))
    const failed = responses.filter((response) => response.status !== 200)
    const todos = await snapshotTodos()
    return {
      pass: failed.length === 0 && todos.length === 10,
      text: `失败请求=${failed.length} 写入条数=${todos.length}`
    }
  })

await probe('C15', 'requirement', 'api.md 1', '写请求缺少 x-dsh-todo 标记返回 403 且不改动文件',
  'status=403 且文件哈希不变', async () => {
    const before = await fileHash()
    const response = await request('POST', '/create', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '无标记写入', quadrant: 'urgent-important' })
    })
    const after = await fileHash()
    const outcome = expectError(response, 403, '缺少写入标记')
    return { pass: outcome.pass && before === after, text: `${outcome.text} 文件未改=${before === after}` }
  })

await probe('C16', 'requirement', 'api.md 1', '写请求必须使用 application/json',
  'status=400 且错误含「content-type」', async () => {
    const response = await request('POST', '/create', {
      headers: { 'content-type': 'text/plain', 'x-dsh-todo': '1' },
      body: '{"title":"文本请求","quadrant":"urgent-important"}'
    })
    return expectError(response, 400, 'content-type')
  })

await probe('C17', 'requirement', 'PRD 6.6 校验、PRD 7', '标题长度上限 200 字',
  '200 字通过，201 字被拒', async () => {
    const ok = await postJson('/create', { title: '标'.repeat(200), quadrant: 'urgent-important' })
    const rejected = await postJson('/create', { title: '标'.repeat(201), quadrant: 'urgent-important' })
    return {
      pass: ok.status === 200 && rejected.status === 400 && String(rejected.payload.error).includes('200'),
      text: `200 字 status=${ok.status} 201 字 status=${rejected.status} 错误=${String(rejected.payload.error ?? '')}`
    }
  })

await probe('C18', 'requirement', 'PRD 6.6 校验、PRD 7、api.md 3', '描述长度上限 20000 字',
  '20000 字通过，20001 字被拒', async () => {
    const ok = await postJson('/create', { title: '描述上限样例', description: '文'.repeat(20000), quadrant: 'urgent-important' })
    const rejected = await postJson('/create', { title: '描述超限样例', description: '文'.repeat(20001), quadrant: 'urgent-important' })
    return {
      pass: ok.status === 200 && rejected.status === 400 && String(rejected.payload.error).includes('20000'),
      text: `20000 字 status=${ok.status} 20001 字 status=${rejected.status} 错误=${String(rejected.payload.error ?? '')}`
    }
  })

await probe('C19', 'requirement', 'PRD 7 dueAt', '计划截止时间必须带时区标识',
  '无时区取值被拒，带时区取值通过', async () => {
    const rejected = await postJson('/create', { title: '无时区样例', quadrant: 'urgent-important', dueAt: '2026-11-10T09:00' })
    const ok = await postJson('/create', { title: '带时区样例', quadrant: 'urgent-important', dueAt: '2026-11-10T09:00+08:00' })
    return {
      pass: rejected.status === 400 && ok.status === 200,
      text: `无时区 status=${rejected.status} 带时区 status=${ok.status}`
    }
  })

await probe('C20', 'requirement', 'api.md 4.6', '删除不存在的标识忽略，完成不存在的标识报错',
  'remove 返回 200 且 removedIds 为空；complete 返回 400', async () => {
    const removeResponse = await postJson('/remove', { ids: ['t_absent'] })
    const completeResponse = await postJson('/complete', { ids: ['t_absent'], includeChildren: false })
    return {
      pass: removeResponse.status === 200 && removeResponse.payload.value.removedIds.length === 0 && completeResponse.status === 400,
      text: `remove status=${removeResponse.status} removedIds=${removeResponse.payload.value?.removedIds?.length} complete status=${completeResponse.status}`
    }
  })

await probe('C21', 'requirement', 'PRD 12.2', '写入失败时就地报错且错误文本包含文件路径',
  'status=500 且错误含「数据文件不可写」与路径', async () => {
    await resetData()
    await writeDataText(JSON.stringify(fixtureDocument(), null, 2))
    // 正式文件只读时读取仍可成功，重命名覆盖被系统拒绝。
    // POSIX 上「目录可写 + 文件只读」仍能 rename 覆盖，原子写会换掉只读文件，
    // 所以额外把目录也设为只读，两种写法的失败路径都盖住。
    const posix = process.platform !== 'win32'
    await fsp.chmod(dataFile, 0o444)
    if (posix) await fsp.chmod(dataDir, 0o555)
    const response = await postJson('/create', { title: '写入失败样例', quadrant: 'urgent-important' })
    if (posix) await fsp.chmod(dataDir, 0o755)
    await fsp.chmod(dataFile, 0o666)
    const leftovers = (await fsp.readdir(dataDir)).filter((name) => name.startsWith('todos.json.') && name.endsWith('.tmp'))
    await resetData()
    const message = String(response.payload.error ?? '')
    return {
      pass: response.status === 500 && message.includes('数据文件不可写') && message.includes(dataFile) && leftovers.length === 0,
      text: `status=${response.status} 错误=${message} 残留临时文件=${leftovers.length}`
    }
  })

await probe('C22', 'requirement', 'PRD 12.3', '文件被改坏后下一次请求立即报错，无需重启',
  '同一个进程内改坏文件后立刻返回 500，恢复文件后立刻返回 200', async () => {
    await resetData()
    await writeDataText('{ 坏文件 ')
    const broken = await request('GET', '/snapshot')
    await resetData()
    const healthy = await request('GET', '/snapshot')
    return {
      pass: broken.status === 500 && healthy.status === 200,
      text: `改坏后 status=${broken.status}，恢复后 status=${healthy.status}`
    }
  })

// ---------- 汇总 ----------

await new Promise((resolve) => server.close(resolve))

const requirementResults = results.filter((item) => item.kind === 'requirement')
const failures = requirementResults.filter((item) => item.pass === false)
const observations = results.filter((item) => item.kind === 'observation')

console.log('')
console.log(`数据目录：${dataDir}`)
console.log(`路由数量：${handlers.size}（脚本启动时已校验为 9）`)
console.log('')
for (const item of results) {
  const tag = item.kind === 'observation' ? '[观察]' : item.pass ? '[通过]' : '[不通过]'
  console.log(`${tag} ${item.id} ${item.description}`)
  console.log(`        依据：${item.clause}`)
  console.log(`        期望：${item.expected}`)
  console.log(`        实际：${item.actual}${item.verdict === null ? '' : `（判定：${item.verdict}）`}`)
}
console.log('')
console.log(`规则项合计 ${requirementResults.length} 条：通过 ${requirementResults.length - failures.length} 条，不通过 ${failures.length} 条`)
console.log(`观察项合计 ${observations.length} 条`)
if (failures.length > 0) {
  console.log(`不通过清单：${failures.map((item) => item.id).join('、')}`)
}
console.log('')

process.exitCode = failures.length === 0 ? 0 : 1
