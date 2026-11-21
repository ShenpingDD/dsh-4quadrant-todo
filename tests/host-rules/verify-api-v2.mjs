// 2.0 接口层验证：版本兼容、26 条路由、标签、重复生成、提醒、待确认事项、筛选预设、导入撤销、上限
// 直接加载 lib/index.js 的 apply，用真实 node:http 与真实文件系统驱动，
// 数据目录指向本目录下的 .run，不触碰 %DSH_HOME%。用例编号对应 docs/api-v2.md 第 10 节。

import { spawn } from 'node:child_process'
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
const dataDir = path.join(runRoot, `api-v2-${stamp}`)
const dataFile = path.join(dataDir, 'todos.json')

await fsp.mkdir(dataDir, { recursive: true })

// ---------- 启动插件 ----------

const handlers = new Map()
const timers = []
const listeners = new Map()

const webServer = {
  register(route) {
    if (route.kind !== 'exact') throw new Error(`验证脚本只支持 exact 路由，实际 ${route.kind}`)
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
  get(name) {
    if (name === 'webServer') return webServer
    if (name === 'timer') return timer
    return undefined
  },
  get timer() {
    return timer
  },
  effect(fn) {
    return fn()
  },
  on(name, listener) {
    listeners.set(name, listener)
    return () => {
      listeners.delete(name)
    }
  }
}

apply(ctx, { dataDir })

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

function postJson(suffix, body, extraHeaders = {}) {
  return request('POST', suffix, {
    headers: { 'content-type': 'application/json', 'x-dsh-todo': '1', ...extraHeaders },
    body: JSON.stringify(body)
  })
}

function getJson(suffix) {
  return request('GET', suffix)
}

async function resetData() {
  await fsp.rm(dataFile, { force: true })
  for (const name of await fsp.readdir(dataDir)) {
    if (name.startsWith('todos.')) await fsp.rm(path.join(dataDir, name), { force: true, recursive: true })
  }
}

async function writeDataText(text) {
  await fsp.writeFile(dataFile, text, 'utf8')
}

async function writeData(document) {
  await writeDataText(JSON.stringify(document, null, 2))
}

async function readDataJson() {
  return JSON.parse(await fsp.readFile(dataFile, 'utf8'))
}

async function fileHash() {
  return createHash('sha256').update(await fsp.readFile(dataFile)).digest('hex')
}

async function dirNames() {
  return (await fsp.readdir(dataDir)).sort()
}

async function snapshot() {
  const { status, payload } = await getJson('/snapshot')
  if (status !== 200 || payload.ok !== true) throw new Error(`快照读取失败 status=${status} error=${payload.error}`)
  return payload.value
}

async function createTodo(input) {
  const { status, payload } = await postJson('/create', input)
  if (status !== 200 || payload.ok !== true) throw new Error(`建待办失败 status=${status} error=${payload.error}`)
  return payload.value.focusId
}

async function completeTodo(ids, includeChildren = true) {
  return postJson('/complete', { ids, includeChildren })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runScan() {
  const interval = timers.find((item) => item.kind === 'interval' && item.delay === 30000)
  if (interval === undefined) throw new Error('未注册 30 秒间隔的提醒定时器')
  await interval.callback()
  await sleep(60)
}

// ---------- 结果记录 ----------

const results = []

function record(name, description, expected, actual, pass) {
  results.push({ name, description, expected, actual, pass })
  const mark = pass ? 'ok  ' : 'fail'
  console.log(`${mark} ${name}  ${description}`)
  console.log(`      期望: ${expected}`)
  console.log(`      实际: ${actual}`)
}

function check(name, description, expected, actual, pass) {
  record(name, description, expected, actual, pass)
  return pass
}

// ---------- 数据样例 ----------

function fixtureTodo(overrides = {}) {
  return {
    id: 't_fixture',
    title: '接口样例',
    description: '',
    quadrant: 'urgent-important',
    dueAt: null,
    parentId: null,
    status: 'open',
    createdAt: '2026-11-03T00:00:00.000Z',
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

function fixtureDocumentV1(overrides = {}) {
  const { id, title, quadrant, dueAt, status, createdAt, completedAt, ...rest } = fixtureTodo()
  void rest
  const todo = {
    id,
    title,
    description: '',
    quadrant,
    dueAt,
    parentId: null,
    status,
    createdAt,
    completedAt,
    workspaceId: null,
    source: { kind: 'manual' },
    sourceKey: null
  }
  return { version: 1, todos: [todo], collapsed: {}, ...overrides }
}

const ROUTES = [
  '/snapshot',
  '/create',
  '/update',
  '/complete',
  '/reopen',
  '/remove',
  '/setQuadrant',
  '/setCollapsed',
  '/fromConversation',
  '/reminders',
  '/snooze',
  '/duplicateRecurrence',
  '/filterSave',
  '/filterRemove',
  '/export',
  '/import',
  '/import/undo',
  '/upgrade',
  '/pending',
  '/sync/status',
  '/sync/tasklists',
  '/sync/login/start',
  '/sync/login/poll',
  '/sync/tasklists/create',
  '/sync/config',
  '/sync/run'
]

// ---------- A. 路由清单与写入守卫 ----------

{
  const missing = ROUTES.filter((route) => !handlers.has(`${PREFIX}${route}`))
  check('A2-00a', '26 条 exact 路由全部注册', '0 条缺失', `缺失 ${missing.length} 条: ${missing.join(',')}`, missing.length === 0)
  check('A2-00b', '路由总数', '26', String(handlers.size), handlers.size === 26)
}

{
  await resetData()
  await writeData(fixtureDocument())
  const before = await fileHash()
  const response = await request('POST', '/create', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '缺写入标记', quadrant: 'urgent-important' })
  })
  const after = await fileHash()
  check(
    'A2-30',
    '写请求缺 x-dsh-todo 头返回 403 且文件不变',
    'status=403 且哈希不变',
    `status=${response.status} 哈希不变=${before === after}`,
    response.status === 403 && before === after
  )
}

// ---------- B. 版本兼容与升级 ----------

{
  await resetData()
  const v1 = fixtureDocumentV1()
  await writeData(v1)
  const before = await fileHash()
  const value = await snapshot()
  const after = await fileHash()
  const todo = value.todos[0] ?? {}
  const defaults =
    Array.isArray(todo.tags) &&
    todo.tags.length === 0 &&
    todo.recurrence === null &&
    todo.seriesId === null &&
    todo.generatedFromId === null &&
    todo.reminder === null &&
    todo.remindedAt === null &&
    todo.startedSessionId === null &&
    todo.startedAt === null
  check(
    'A2-01',
    '版本 1 快照按只读兼容加载并补齐字段',
    'dataVersion=1 readOnly=true 新字段取缺省 且文件字节不变',
    `dataVersion=${value.dataVersion} readOnly=${value.readOnly} 补齐=${defaults} 字节不变=${before === after} filters=${Array.isArray(value.filters)}`,
    value.dataVersion === 1 && value.readOnly === true && defaults && before === after && Array.isArray(value.filters)
  )
}

{
  await resetData()
  await writeData(fixtureDocumentV1())
  const before = await fileHash()
  const response = await postJson('/create', { title: '只读期写入', quadrant: 'urgent-important' })
  const after = await fileHash()
  const message = String(response.payload.error ?? '')
  check(
    'A2-02',
    '版本 1 状态下写请求被拒绝',
    'status=400 且 error 含「数据格式为 1.0，请先升级」且文件不变',
    `status=${response.status} error=${message} 字节不变=${before === after}`,
    response.status === 400 && message.includes('数据格式为 1.0，请先升级') && before === after
  )
}

{
  await resetData()
  await writeData(fixtureDocumentV1())
  const originalBytes = await fsp.readFile(dataFile)
  const response = await postJson('/upgrade', { confirm: true })
  const names = await dirNames()
  const backupName = names.find((name) => /^todos\.v1-.*\.json$/.test(name))
  const backupBytes = backupName === undefined ? null : await fsp.readFile(path.join(dataDir, backupName))
  const data = await readDataJson()
  const created = await postJson('/create', { title: '升级后写入', quadrant: 'urgent-important' })
  const sameTodo = data.todos.length === 1 && data.todos[0].title === '接口样例'
  check(
    'A2-03',
    '升级生成备份并写入版本 2',
    'status=200 出现 todos.v1-*.json 且字节与原文件相同，主文件 version=2，meta.upgradedFrom=1，随后 /create 返回 200',
    `status=${response.status} 备份=${backupName} 备份字节相同=${backupBytes !== null && Buffer.compare(originalBytes, backupBytes) === 0} version=${data.version} upgradedFrom=${data.meta?.upgradedFrom} 条目取值不变=${sameTodo} 后续写入=${created.status}`,
    response.status === 200 &&
      backupName !== undefined &&
      backupBytes !== null &&
      Buffer.compare(originalBytes, backupBytes) === 0 &&
      data.version === 2 &&
      data.meta?.upgradedFrom === 1 &&
      sameTodo &&
      created.status === 200
  )
}

{
  await resetData()
  await writeData(fixtureDocument())
  const before = await fileHash()
  const response = await postJson('/upgrade', { confirm: true })
  const after = await fileHash()
  const message = String(response.payload.error ?? '')
  check(
    'A2-04',
    '版本 2 状态下再次升级被拒绝',
    'status=400 且 error 含「数据已经是 2.0 格式」且文件不变',
    `status=${response.status} error=${message} 字节不变=${before === after}`,
    response.status === 400 && message.includes('数据已经是 2.0 格式') && before === after
  )
}

{
  await resetData()
  await writeData(fixtureDocument({ version: 3 }))
  const before = await fileHash()
  const { status, payload } = await getJson('/snapshot')
  const after = await fileHash()
  const message = String(payload.error ?? '')
  const containsPath = message.includes(dataFile)
  check(
    'A2-05',
    '未知版本拒绝加载并给出定位信息',
    'status=500 且 error 含绝对路径、实际值 3、允许值 1 或 2，文件字节不变',
    `status=${status} 含路径=${containsPath} error=${message}`,
    status === 500 && containsPath && message.includes('3') && before === after
  )
}

// ---------- C. 快照与导出字段 ----------

{
  await resetData()
  const id = await createTodo({ title: '导出样例', quadrant: 'urgent-important', tags: ['工作'] })
  const { status, payload } = await getJson('/export')
  const value = payload.value ?? {}
  const keys = ['version', 'todos', 'collapsed', 'filters', 'settings', 'meta']
  const hasAll = keys.every((key) => Object.hasOwn(value, key))
  check(
    'A2-06',
    '导出返回六段完整数据',
    'status=200 且含 version、todos、collapsed、filters、settings、meta，version=2',
    `status=${status} 段齐全=${hasAll} version=${value.version} 条数=${Array.isArray(value.todos) ? value.todos.length : '非数组'} 含新建条目=${Array.isArray(value.todos) && value.todos.some((item) => item.id === id)}`,
    status === 200 && hasAll && value.version === 2 && Array.isArray(value.todos) && value.todos.some((item) => item.id === id)
  )
}

// ---------- D. 标签 ----------

{
  await resetData()
  const many = await postJson('/create', {
    title: '标签数量',
    quadrant: 'urgent-important',
    tags: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11']
  })
  const longTag = await postJson('/create', {
    title: '标签长度',
    quadrant: 'urgent-important',
    tags: ['一二三四五六七八九十一二三四五六七八九十一']
  })
  const newlineTag = await postJson('/create', {
    title: '标签换行',
    quadrant: 'urgent-important',
    tags: ['a\nb']
  })
  check(
    'A2-07',
    '标签数量、长度、换行越界被拒绝',
    '三次 status=400',
    `数量=${many.status} 长度=${longTag.status} 换行=${newlineTag.status}`,
    many.status === 400 && longTag.status === 400 && newlineTag.status === 400
  )
}

{
  await resetData()
  const id = await createTodo({ title: '标签去重', quadrant: 'urgent-important', tags: ['报告', '报告', ' 复盘 '] })
  const data = await readDataJson()
  const todo = data.todos.find((item) => item.id === id)
  check(
    'A2-08',
    '重复标签与空白标签规范化',
    'tags 为 ["报告","复盘"]',
    JSON.stringify(todo?.tags),
    Array.isArray(todo?.tags) && todo.tags.length === 2 && todo.tags[0] === '报告' && todo.tags[1] === '复盘'
  )
}

{
  await resetData()
  const parentId = await createTodo({ title: '重复规则父条', quadrant: 'urgent-important' })
  const childRecurrence = await postJson('/create', {
    title: '子待办带重复',
    parentId,
    recurrence: { freq: 'daily', interval: 1, until: null }
  })
  const conversationRecurrence = await postJson('/create', {
    title: '会话来源带重复',
    quadrant: 'urgent-important',
    source: { kind: 'conversation', sessionId: 's1', entryId: 'e1', entryType: 'question' },
    recurrence: { freq: 'daily', interval: 1, until: null }
  })
  check(
    'A2-09',
    '子待办与会话来源不接受重复设置',
    '两次 status=400',
    `子待办=${childRecurrence.status} 会话来源=${conversationRecurrence.status}`,
    childRecurrence.status === 400 && conversationRecurrence.status === 400
  )
}

// ---------- E. 重复生成 ----------

{
  await resetData()
  const dueAt = '2026-11-05T09:00:00+08:00'
  const id = await createTodo({
    title: '每日站会纪要',
    quadrant: 'urgent-important',
    dueAt,
    tags: ['工作'],
    recurrence: { freq: 'daily', interval: 1, until: '2026-11-08T09:00:00+08:00' },
    reminder: { leadMinutes: 30 }
  })
  const completed = await completeTodo([id])
  const data = await readDataJson()
  const done = data.todos.find((item) => item.id === id)
  const next = data.todos.find((item) => item.generatedFromId === id)
  const sameSeries = next !== undefined && done !== undefined && next.seriesId !== null && next.seriesId === done.seriesId
  const dueShifted = next !== undefined && Date.parse(next.dueAt) - Date.parse(dueAt) === 24 * 3600 * 1000
  const fieldsCopied =
    next !== undefined &&
    next.title === '每日站会纪要' &&
    next.quadrant === 'urgent-important' &&
    JSON.stringify(next.tags) === JSON.stringify(['工作']) &&
    next.status === 'open' &&
    next.completedAt === null &&
    next.remindedAt === null &&
    next.reminder !== null &&
    next.reminder.snoozeUntil === null &&
    next.source.kind === 'manual' &&
    next.sourceKey === null
  check(
    'A2-11',
    '完成按天重复的待办生成下一条',
    'status=200，已完成条与新条共享 seriesId，generatedFromId 指向原条，dueAt 推进 1 天，字段与标签与提醒复制，状态为 open',
    `status=${completed.status} seriesId 相同=${sameSeries} 推进一天=${dueShifted} 字段复制=${fieldsCopied} 新条 dueAt=${next?.dueAt}`,
    completed.status === 200 && sameSeries && dueShifted && fieldsCopied
  )
}

{
  await resetData()
  const id = await createTodo({
    title: '连点与撤销',
    quadrant: 'urgent-important',
    dueAt: '2026-11-05T09:00:00+08:00',
    recurrence: { freq: 'daily', interval: 1, until: null }
  })
  await completeTodo([id])
  await completeTodo([id])
  await postJson('/reopen', { ids: [id] })
  await completeTodo([id])
  const data = await readDataJson()
  const sameDue = new Set(data.todos.filter((item) => item.dueAt !== null).map((item) => item.dueAt)).size
  check(
    'A2-12',
    '重复提交与撤销后再次完成不产生重复实例',
    '条目数为 2 且 dueAt 无重复',
    `条目数=${data.todos.length} 不同 dueAt=${sameDue}`,
    data.todos.length === 2 && sameDue === 2
  )
}

{
  await resetData()
  const id = await createTodo({
    title: '月末推进',
    quadrant: 'urgent-important',
    dueAt: '2026-01-31T09:00:00+08:00',
    recurrence: { freq: 'monthly', interval: 1, until: null }
  })
  await completeTodo([id])
  const data1 = await readDataJson()
  const first = data1.todos.find((item) => item.generatedFromId === id)
  const firstOk = first !== undefined && first.dueAt.slice(0, 10) === '2026-02-28'
  let secondOk = false
  let secondDue = '未生成'
  if (first !== undefined) {
    await completeTodo([first.id])
    const data2 = await readDataJson()
    const second = data2.todos.find((item) => item.generatedFromId === first.id)
    secondOk = second !== undefined && second.dueAt.slice(0, 10) === '2026-03-31'
    secondDue = second?.dueAt ?? '未生成'
  }
  check(
    'A2-13',
    '按月重复对月末做截断',
    '第 1 条为 2026-02-28，第 2 条为 2026-03-31',
    `第 1 条=${first?.dueAt ?? '未生成'} 第 2 条=${secondDue}`,
    firstOk && secondOk
  )
}

{
  await resetData()
  const dueAt = '2026-11-08T09:00:00+08:00'
  const id = await createTodo({
    title: '重复终止',
    quadrant: 'urgent-important',
    dueAt,
    recurrence: { freq: 'daily', interval: 1, until: dueAt }
  })
  await completeTodo([id])
  const data = await readDataJson()
  const done = data.todos.find((item) => item.id === id)
  check(
    'A2-14',
    '最后一条不再生成并把重复设置置空',
    '条目数 1，recurrence 为 null',
    `条目数=${data.todos.length} recurrence=${JSON.stringify(done?.recurrence)}`,
    data.todos.length === 1 && done?.recurrence === null
  )
}

{
  await resetData()
  const id = await createTodo({
    title: '带子待办的重复',
    quadrant: 'urgent-important',
    dueAt: '2026-11-05T09:00:00+08:00',
    recurrence: { freq: 'weekly', interval: 1, until: null }
  })
  await postJson('/create', { title: '写提纲', parentId: id })
  await postJson('/create', { title: '补数据', parentId: id })
  await completeTodo([id], true)
  const data = await readDataJson()
  const next = data.todos.find((item) => item.generatedFromId === id)
  const children = data.todos.filter((item) => item.parentId === next?.id)
  const titles = children.map((item) => item.title).sort().join(',')
  const reset = children.every((item) => item.status === 'open' && item.completedAt === null && item.dueAt === null)
  check(
    'A2-15',
    '新实例复制子待办标题并重置状态',
    '两条子待办，标题为 写提纲 与 补数据，状态 open，completedAt 与 dueAt 为 null',
    `子待办数=${children.length} 标题=${titles} 重置=${reset}`,
    next !== undefined && children.length === 2 && titles === '写提纲,补数据' && reset
  )
}

// ---------- F. 复制重复设置 ----------

{
  await resetData()
  const sourceId = await createTodo({
    title: '已设重复的源',
    quadrant: 'urgent-important',
    recurrence: { freq: 'weekly', interval: 2, until: null }
  })
  const targetId = await createTodo({ title: '待复制重复设置', quadrant: 'urgent-important' })
  const response = await postJson('/duplicateRecurrence', { sourceId, targetId })
  const data = await readDataJson()
  const target = data.todos.find((item) => item.id === targetId)
  const childOfSource = await postJson('/create', { title: '源条的子待办', parentId: sourceId })
  const childId = childOfSource.payload.value?.focusId
  const rejected = await postJson('/duplicateRecurrence', { sourceId, targetId: childId })
  check(
    'A2-19',
    '复制重复设置到目标并拒绝子待办',
    'status=200，目标 recurrence 为 weekly/2，seriesId 仍为 null，子待办作为目标返回 400',
    `status=${response.status} freq=${target?.recurrence?.freq} interval=${target?.recurrence?.interval} seriesId=${target?.seriesId} 子待办=${rejected.status}`,
    response.status === 200 &&
      target?.recurrence?.freq === 'weekly' &&
      target?.recurrence?.interval === 2 &&
      target?.seriesId === null &&
      rejected.status === 400
  )
}

// ---------- G. 提醒 ----------

{
  await resetData()
  const interval = timers.find((item) => item.kind === 'interval' && item.delay === 30000)
  const kickoff = timers.find((item) => item.kind === 'timeout' && item.delay === 5000)
  const due = new Date(Date.now() + 60 * 1000)
  const id = await createTodo({
    title: '到点提醒',
    quadrant: 'urgent-important',
    dueAt: due.toISOString(),
    reminder: { leadMinutes: 5 }
  })
  await runScan()
  const data = await readDataJson()
  const todo = data.todos.find((item) => item.id === id)
  const { status, payload } = await getJson('/reminders')
  const value = payload.value ?? {}
  const listed = Array.isArray(value.items) && value.items.some((item) => item.id === id)
  await runScan()
  const data2 = await readDataJson()
  const stable = data2.todos.find((item) => item.id === id)?.remindedAt === todo?.remindedAt
  check(
    'A2-17',
    '定时器写入 remindedAt 并且只提醒一次',
    '注册 30 秒间隔与 5 秒首次扫描，扫描后 remindedAt 非空，/reminders 计数 1，再次扫描 remindedAt 不变',
    `间隔=${interval?.delay} 首次=${kickoff?.delay} remindedAt=${todo?.remindedAt ?? '空'} count=${value.count} 命中=${listed} 再次扫描不变=${stable}`,
    interval !== undefined && kickoff !== undefined && todo?.remindedAt !== null && value.count === 1 && listed && stable
  )
}

{
  const data = await readDataJson()
  const id = data.todos[0].id
  const snoozed = await postJson('/snooze', { id, minutes: 10 })
  const data2 = await readDataJson()
  const todo = data2.todos.find((item) => item.id === id)
  const { payload } = await getJson('/reminders')
  check(
    'A2-18',
    '稍后 10 分钟清空提醒并写入 snoozeUntil',
    'status=200，remindedAt 为 null，snoozeUntil 约为当前加 10 分钟，/reminders 计数 0',
    `status=${snoozed.status} remindedAt=${todo?.remindedAt} snoozeUntil=${todo?.reminder?.snoozeUntil} count=${payload.value?.count}`,
    snoozed.status === 200 &&
      todo?.remindedAt === null &&
      typeof todo?.reminder?.snoozeUntil === 'string' &&
      payload.value?.count === 0
  )
}

{
  const data = await readDataJson()
  const id = data.todos[0].id
  await postJson('/update', { id, reminder: { leadMinutes: 5 } })
  await postJson('/update', { id, dueAt: new Date(Date.now() + 2 * 60 * 1000).toISOString() })
  await runScan()
  const data2 = await readDataJson()
  const first = data2.todos.find((item) => item.id === id)
  await postJson('/update', { id, dueAt: new Date(Date.now() + 3 * 60 * 1000).toISOString() })
  const data3 = await readDataJson()
  const second = data3.todos.find((item) => item.id === id)
  check(
    'A2-16',
    '修改截止时间清除已提醒标记',
    '第一次改期后扫描写入 remindedAt，第二次改期后 remindedAt 为 null',
    `改期后提醒=${first?.remindedAt ?? '空'} 再改期后=${second?.remindedAt}`,
    typeof first?.remindedAt === 'string' && second?.remindedAt === null
  )
}

// ---------- G. 筛选预设 ----------

{
  await resetData()
  const conditions = {
    tags: ['工作'],
    quadrants: [],
    dueState: 'all',
    dueRange: { kind: 'any', from: null, to: null },
    source: 'all',
    keyword: ''
  }
  const created = await postJson('/filterSave', { preset: { name: '本周遗留', conditions } })
  const firstFilter = created.payload.value?.filters?.[0]
  await sleep(15)
  const updated = await postJson('/filterSave', {
    preset: { id: firstFilter?.id, name: '本周遗留', conditions: { ...conditions, keyword: '报告' } }
  })
  const after = updated.payload.value?.filters?.[0]
  check(
    'A2-20',
    '预设新建与更新',
    '两次 status=200，更新后 keyword 为 报告且 updatedAt 变化',
    `新建=${created.status} 更新=${updated.status} keyword=${after?.conditions?.keyword} updatedAt 变化=${firstFilter?.updatedAt !== after?.updatedAt}`,
    created.status === 200 &&
      updated.status === 200 &&
      after?.conditions?.keyword === '报告' &&
      firstFilter?.updatedAt !== after?.updatedAt
  )
}

{
  const conditions = {
    tags: [],
    quadrants: [],
    dueState: 'all',
    dueRange: { kind: 'any', from: null, to: null },
    source: 'all',
    keyword: ''
  }
  const duplicate = await postJson('/filterSave', { preset: { name: '本周遗留', conditions } })
  let lastStatus = 0
  for (let index = 2; index <= 20; index += 1) {
    const response = await postJson('/filterSave', { preset: { name: `预设 ${index}`, conditions } })
    lastStatus = response.status
  }
  const overflow = await postJson('/filterSave', { preset: { name: '预设 21', conditions } })
  const data = await readDataJson()
  check(
    'A2-21',
    '预设重名与超过 20 个被拒绝',
    '重名 status=400，前 19 次 200，第 21 个 status=400，文件内 20 条',
    `重名=${duplicate.status} 第 20 个=${lastStatus} 第 21 个=${overflow.status} 实际条数=${data.filters.length}`,
    duplicate.status === 400 && lastStatus === 200 && overflow.status === 400 && data.filters.length === 20
  )
}

{
  const missing = await postJson('/filterRemove', { id: 'f_not_exist' })
  const data = await readDataJson()
  const removed = await postJson('/filterRemove', { id: data.filters[0].id })
  const data2 = await readDataJson()
  check(
    'A2-22',
    '删除预设与不存在标识',
    '不存在返回 400，删除后 filters 为 19 条',
    `不存在=${missing.status} 删除=${removed.status} 剩余=${data2.filters.length}`,
    missing.status === 400 && removed.status === 200 && data2.filters.length === 19
  )
}

// ---------- H. 导入、撤销与校验 ----------

function importPayload(document) {
  return { payload: document, fileName: 'backup.json' }
}

{
  await resetData()
  await writeData(fixtureDocument())
  const payloadDocument = fixtureDocument({
    todos: [1, 2, 3, 4, 5].map((index) => fixtureTodo({ id: `t_imp${index}`, title: `导入条目 ${index}` }))
  })
  const response = await postJson('/import', importPayload(payloadDocument))
  const names = await dirNames()
  const backupName = names.find((name) => /^todos\.before-import-.*\.json$/.test(name))
  const data = await readDataJson()
  check(
    'A2-23',
    '合法导入整份替换并生成备份',
    'status=200，importedCount=5，出现 todos.before-import-*.json，主文件 5 条',
    `status=${response.status} importedCount=${response.payload.value?.importedCount} 备份=${backupName} 条数=${data.todos.length}`,
    response.status === 200 && response.payload.value?.importedCount === 5 && backupName !== undefined && data.todos.length === 5
  )
}

{
  const before = await fileHash()
  const cases = [
    ['版本 3', fixtureDocument({ version: 3 })],
    ['标识重复', fixtureDocument({ todos: [fixtureTodo({ id: 't_dup' }), fixtureTodo({ id: 't_dup', title: '另一条' })] })],
    ['父标识悬空', fixtureDocument({ todos: [fixtureTodo({ id: 't_orphan', parentId: 't_missing' })] })],
    ['标题超长', fixtureDocument({ todos: [fixtureTodo({ title: '标'.repeat(201) })] })],
    ['时间格式错误', fixtureDocument({ todos: [fixtureTodo({ dueAt: '2026/11/05 09:00' })] })],
    ['象限标识非法', fixtureDocument({ todos: [fixtureTodo({ quadrant: 'unknown' })] })],
    ['提醒提前量非法', fixtureDocument({ todos: [fixtureTodo({ reminder: { leadMinutes: 7, snoozeUntil: null } })] })],
    ['重复键冲突', fixtureDocument({ todos: [
      fixtureTodo({ id: 't_s1', seriesId: 's_x', dueAt: '2026-11-05T09:00:00+08:00' }),
      fixtureTodo({ id: 't_s2', seriesId: 's_x', dueAt: '2026-11-05T09:00:00+08:00' })
    ] })]
  ]
  const outcomes = []
  for (const [name, document] of cases) {
    const response = await postJson('/import', importPayload(document))
    outcomes.push(`${name}=${response.status}`)
  }
  const after = await fileHash()
  const passed = outcomes.every((item) => item.endsWith('=400'))
  check(
    'A2-24',
    '八类非法导入全部被拒绝且主文件不变',
    '每类 status=400，主文件哈希不变',
    `${outcomes.join(' ')} 哈希不变=${before === after}`,
    passed && before === after
  )
}

{
  const badJson = await request('POST', '/import', {
    headers: { 'content-type': 'application/json', 'x-dsh-todo': '1' },
    body: '{"payload":'
  })
  const before = await fileHash()
  check(
    'A2-24b',
    '请求体不是合法 JSON 时返回 400',
    'status=400',
    `status=${badJson.status} 哈希不变=${before === (await fileHash())}`,
    badJson.status === 400
  )
}

{
  const data = await readDataJson()
  const names = await dirNames()
  const backupName = names.find((name) => /^todos\.before-import-.*\.json$/.test(name))
  const response = await postJson('/import/undo', { backupFile: backupName })
  const restored = await readDataJson()
  check(
    'A2-25',
    '撤销导入恢复导入前内容',
    'status=200，主文件回到 0 条',
    `status=${response.status} restoredCount=${response.payload.value?.restoredCount} 条数=${restored.todos.length}（撤销前 ${data.todos.length} 条）`,
    response.status === 200 && restored.todos.length === 0
  )
}

{
  const outside = await postJson('/import/undo', { backupFile: '../../../etc/passwd' })
  const message = String(outside.payload.error ?? '')
  const missing = await postJson('/import/undo', { backupFile: 'todos.before-import-20000101-000000.json' })
  check(
    'A2-27',
    '撤销只接受数据目录内的备份文件名',
    '路径穿越与不存在的备份都返回 400',
    `穿越=${outside.status}(${message.slice(0, 24)}) 不存在=${missing.status}`,
    outside.status === 400 && missing.status === 400
  )
}

{
  await resetData()
  await writeData(fixtureDocument())
  const v1Document = fixtureDocumentV1()
  const response = await postJson('/import', importPayload(v1Document))
  const data = await readDataJson()
  const todo = data.todos[0]
  check(
    'A2-26',
    '导入版本 1 的文件按升级规则补齐',
    'status=200，fromVersion=1，主文件 version=2，条目补齐新字段',
    `status=${response.status} fromVersion=${response.payload.value?.fromVersion} version=${data.version} tags=${JSON.stringify(todo?.tags)}`,
    response.status === 200 &&
      response.payload.value?.fromVersion === 1 &&
      data.version === 2 &&
      Array.isArray(todo?.tags) &&
      todo.tags.length === 0
  )
}

// ---------- I. 并发与上限 ----------

{
  await resetData()
  const responses = await Promise.all(Array.from({ length: 8 }, () => getJson('/snapshot')))
  const allOk = responses.every((item) => item.status === 200 && item.payload.ok === true)
  const data = await readDataJson()
  check(
    'A2-29',
    '八次并发快照后数据文件仍可解析',
    '八次 status=200，文件 version=2',
    `全部 200=${allOk} version=${data.version}`,
    allOk && data.version === 2
  )
}

{
  await resetData()
  const done = []
  for (let index = 0; index < 19999; index += 1) {
    done.push(
      fixtureTodo({
        id: `t_done_${index}`,
        title: `已完成 ${index}`,
        status: 'done',
        completedAt: '2026-11-01T00:00:00.000Z',
        createdAt: '2026-10-01T00:00:00.000Z'
      })
    )
  }
  done.push(
    fixtureTodo({
      id: 't_limit',
      title: '上限边界',
      dueAt: '2026-11-05T09:00:00+08:00',
      recurrence: { freq: 'daily', interval: 1, until: null }
    })
  )
  await writeData(fixtureDocument({ todos: done }))
  const response = await completeTodo(['t_limit'])
  const data = await readDataJson()
  const message = String(response.payload.error ?? '')
  const rejected = response.status === 400 && message.includes('上限')
  const noNewInstance = data.todos.every((item) => item.generatedFromId === null)
  const keptDone = data.todos.find((item) => item.id === 't_limit')?.status === 'done'
  check(
    'A2-28',
    '已完成达到 20000 条时拒绝生成新实例',
    'status=400，error 含「上限」，不生成新条，原条完成状态保留',
    `status=${response.status} error=${message.slice(0, 40)} 未生成=${noNewInstance} 原条已完成=${keptDone}`,
    rejected && noNewInstance && keptDone
  )
}

// ---------- 汇总 ----------

{
  const missing = await getJson('/pending')
  check(
    'A2-31',
    '/pending 缺少 sessionId 返回 400',
    'status=400 且 error 含 sessionId',
    `status=${missing.status} error=${String(missing.payload.error ?? '').slice(0, 20)}`,
    missing.status === 400 && String(missing.payload.error ?? '').includes('sessionId')
  )
}

{
  const listener = listeners.get('user-questions/request')
  let release = null
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const running = listener(
    { agent: { sessionId: 'sess-verify' }, questions: [{ question: '要不要现在发布？' }], wait: { callId: 'call-verify' } },
    async () => {
      await gate
      return { answers: [] }
    }
  )
  const during = await getJson('/pending?sessionId=sess-verify')
  const first = during.payload.value?.items?.[0]
  release()
  await running
  const after = await getJson('/pending?sessionId=sess-verify')
  const recorded = during.status === 200 && during.payload.value.count === 1 && first?.entryType === 'question' && first?.entryId === 'call-verify'
  const cleared = after.status === 200 && after.payload.value.count === 0
  check(
    'A2-32',
    '提问请求在等待期间可被列出，回答后清空',
    '/pending 计数 1 且来源类型为 question，next 完成后计数 0',
    `等待中=${during.payload.value?.count} 标题=${first?.title ?? '空'} 结束后=${after.payload.value?.count}`,
    recorded && cleared
  )
}

// ---------- J. 重复链、提醒补发与新字段恒定值 ----------

{
  await resetData()
  const id = await createTodo({
    title: '未定日期的每日重复',
    quadrant: 'urgent-important',
    recurrence: { freq: 'daily', interval: 1, until: null }
  })
  const completed = await completeTodo([id])
  const data = await readDataJson()
  const done = data.todos.find((item) => item.id === id)
  const next = data.todos.find((item) => item.parentId === null && item.generatedFromId === id)
  const expected = new Date(done?.completedAt ?? 0)
  expected.setUTCSeconds(0, 0)
  expected.setUTCDate(expected.getUTCDate() + 1)
  const advanced = next !== undefined && Date.parse(next.dueAt) === expected.getTime()
  check(
    'A2-33',
    '截止时间为空的重复条目完成后按完成时刻推进',
    'status=200，生成下一条且 dueAt 为完成时刻取整到分钟再加一天，两条共享 seriesId',
    `status=${completed.status} 新条目=${next === undefined ? '无' : next.dueAt} 期望=${expected.toISOString()} seriesId 一致=${next !== undefined && next.seriesId === done?.seriesId}`,
    completed.status === 200 &&
      done?.status === 'done' &&
      next !== undefined &&
      advanced &&
      next.seriesId !== null &&
      next.seriesId === done?.seriesId
  )
}

{
  await resetData()
  const dueAt = new Date(Date.now() + 86400000).toISOString()
  const id = await createTodo({
    title: '重复链首条',
    quadrant: 'urgent-important',
    dueAt,
    recurrence: { freq: 'daily', interval: 1, until: null }
  })
  await completeTodo([id])
  const before = await readDataJson()
  const next = before.todos.find((item) => item.generatedFromId === id)
  const removed = await postJson('/remove', { ids: [id] })
  const after = await readDataJson()
  const survivor = after.todos.find((item) => item.id === next?.id)
  const value = await snapshot()
  const message = String(removed.payload.error ?? '')
  check(
    'A2-34',
    '删除重复链首条不影响链中其它条目',
    'status=200，链中条目仍在且 generatedFromId 续接为 null，快照仍可读取',
    `status=${removed.status} error=${message} 链中条目=${survivor === undefined ? '缺失' : '存在'} generatedFromId=${String(survivor?.generatedFromId)} 快照条目=${value.todos.length}`,
    removed.status === 200 &&
      survivor !== undefined &&
      survivor.generatedFromId === null &&
      survivor.seriesId === next?.seriesId &&
      value.todos.length === after.todos.length
  )
}

{
  await resetData()
  const dueAt = new Date(Date.now() - 3 * 86400000).toISOString()
  const id = await createTodo({
    title: '三天前到期且从未提醒',
    quadrant: 'urgent-important',
    dueAt,
    reminder: { leadMinutes: 0 }
  })
  await runScan()
  const data = await readDataJson()
  const todo = data.todos.find((item) => item.id === id)
  const { payload } = await getJson('/reminders')
  check(
    'A2-35',
    '逾期多日且从未提醒的条目在启动后补发一次',
    '扫描后 remindedAt 非空，/reminders 计数 1',
    `remindedAt=${todo?.remindedAt ?? '空'} count=${payload.value?.count}`,
    typeof todo?.remindedAt === 'string' && payload.value?.count === 1
  )
}

{
  await resetData()
  const dueAt = new Date(Date.now() + 3600000).toISOString()
  const withDue = await createTodo({ title: '省略提醒且已排期', quadrant: 'urgent-important', dueAt })
  const withoutDue = await createTodo({ title: '省略提醒且未排期', quadrant: 'urgent-important' })
  const data = await readDataJson()
  const first = data.todos.find((item) => item.id === withDue)
  const second = data.todos.find((item) => item.id === withoutDue)
  const expectedLead = data.settings.reminderLeadMinutes
  check(
    'A2-36',
    '新建时省略提醒取设置项默认提前量',
    `两条的 reminder 均为 { leadMinutes: ${expectedLead}, snoozeUntil: null }`,
    `已排期=${JSON.stringify(first?.reminder)} 未排期=${JSON.stringify(second?.reminder)}`,
    first?.reminder?.leadMinutes === expectedLead &&
      first?.reminder?.snoozeUntil === null &&
      second?.reminder?.leadMinutes === expectedLead &&
      second?.reminder?.snoozeUntil === null
  )
}

{
  await resetData()
  const parentId = await createTodo({ title: '父任务', quadrant: 'urgent-important' })
  const childWithReminder = await postJson('/create', { title: '带提醒的子待办', parentId, reminder: { leadMinutes: 5 } })
  const childWithTag = await postJson('/create', { title: '带标签的子待办', parentId, tags: ['工作'] })
  const plainChild = await postJson('/create', { title: '普通子待办', parentId, tags: [], reminder: null })
  const childId = plainChild.payload.value?.focusId
  const updateReminder = await postJson('/update', { id: childId, reminder: { leadMinutes: 15 } })
  const updateTags = await postJson('/update', { id: childId, tags: ['工作'] })
  const data = await readDataJson()
  const child = data.todos.find((item) => item.id === childId)
  check(
    'A2-37',
    '子待办的新字段保持恒定值',
    '带提醒与带标签的新建请求返回 400，普通子待办 reminder 为 null、tags 为空数组，改提醒与改标签的更新请求返回 400',
    `新建带提醒=${childWithReminder.status} 新建带标签=${childWithTag.status} 新建普通=${plainChild.status} reminder=${String(child?.reminder)} tags=${JSON.stringify(child?.tags)} 改提醒=${updateReminder.status} 改标签=${updateTags.status}`,
    childWithReminder.status === 400 &&
      childWithTag.status === 400 &&
      plainChild.status === 200 &&
      child?.reminder === null &&
      Array.isArray(child?.tags) &&
      child.tags.length === 0 &&
      updateReminder.status === 400 &&
      updateTags.status === 400
  )
}

{
  await resetData()
  const base = {
    sessionId: 'sess-a2-38',
    entryId: 'entry-1',
    entryType: 'question',
    title: '会话来源与提醒'
  }
  const rejected = await postJson('/fromConversation', { ...base, reminder: { leadMinutes: 30 } })
  const accepted = await postJson('/fromConversation', { ...base, entryId: 'entry-2' })
  const data = await readDataJson()
  const created = data.todos.find((item) => item.source?.entryId === 'entry-2')
  check(
    'A2-38',
    '会话来源的待办不接受提醒设置',
    '带 reminder 返回 400，不带时返回 200 且 reminder 为 null',
    `带提醒=${rejected.status} 不带=${accepted.status} reminder=${String(created?.reminder)}`,
    rejected.status === 400 && accepted.status === 200 && created?.reminder === null
  )
}

{
  await resetData()
  await writeData(fixtureDocument({
    todos: [fixtureTodo({ status: 'open', completedAt: '2026-11-03T01:00:00.000Z' })]
  }))
  const badCompleted = await getJson('/snapshot')
  await resetData()
  const id = await createTodo({ title: '会话标记', quadrant: 'urgent-important' })
  const onlySession = await postJson('/update', { id, startedSessionId: 'sess-a2-39' })
  const both = await postJson('/update', { id, startedSessionId: 'sess-a2-39', startedAt: new Date().toISOString() })
  const data = await readDataJson()
  const todo = data.todos.find((item) => item.id === id)
  check(
    'A2-39',
    '状态与会话标记的结构校验',
    '未完成条目带 completedAt 时快照返回 500；只传 startedSessionId 的更新返回 400，两项同传返回 200',
    `坏文件快照=${badCompleted.status} 只传会话=${onlySession.status} 同传=${both.status} startedAt=${String(todo?.startedAt)}`,
    badCompleted.status === 500 &&
      String(badCompleted.payload.error ?? '').includes('数据文件结构不合法') &&
      onlySession.status === 400 &&
      both.status === 200 &&
      typeof todo?.startedAt === 'string'
  )
}

// 同步脚本最后一行是统计：换象限成功时推送计数应为 1
function moveSummaryIsPushed(stdout) {
  const line = String(stdout ?? '').trim().split('\n').filter((row) => row.startsWith('同步完成')).pop() ?? ''
  return line.includes('推送 1')
}

// ---------- S. 飞书同步管理接口 ----------

{
  const stub = path.join(here, 'stub-lark-cli.mjs')
  await fsp.chmod(stub, 0o755)
  const previousCli = process.env.LARK_CLI
  const previousUser = process.env.STUB_LARK_USER
  const configPath = path.join(dataDir, 'sync-config.json')
  const statePath = path.join(dataDir, 'sync-state.json')
  const logPath = path.join(dataDir, 'sync.log')
  process.env.LARK_CLI = stub
  process.env.STUB_LARK_USER = 'missing'
  await fsp.rm(configPath, { force: true })
  await fsp.rm(statePath, { force: true })
  await fsp.rm(logPath, { force: true })
  await resetData()
  await writeData({ version: 2, todos: [], collapsed: {}, filters: [], settings: { reminderLeadMinutes: 30, statsRange: 'week' }, meta: { upgradedAt: null, upgradedFrom: null } })

  try {
    const status = await getJson('/sync/status')
    const statusValue = status.payload.value ?? {}
    check(
      'S1',
      '状态接口报告 lark-cli 与用户身份',
      '200，installed=true，version=9.9.9-stub，user.ready=false',
      `status=${status.status} installed=${statusValue.cli?.installed} version=${statusValue.cli?.version} ready=${statusValue.auth?.user?.ready}`,
      status.status === 200 && statusValue.cli?.installed === true && statusValue.cli?.version === '9.9.9-stub' && statusValue.auth?.user?.ready === false
    )

    const denied = await getJson('/sync/tasklists')
    check(
      'S2',
      '未登录时读清单返回可操作的错误',
      '409 且错误里提示先登录',
      `status=${denied.status} error=${denied.payload.error}`,
      denied.status === 409 && String(denied.payload.error ?? '').includes('登录')
    )

    const guard = await request('POST', '/sync/login/start', { headers: { 'content-type': 'application/json' }, body: '{}' })
    check('S3', '登录接口受写入标记保护', '403 缺少写入标记', `status=${guard.status}`, guard.status === 403)

    const login = await postJson('/sync/login/start', {})
    const loginValue = login.payload.value ?? {}
    check(
      'S4',
      '设备码登录返回授权链接与二维码文本',
      '200，带 deviceCode 与 verificationUrl',
      `status=${login.status} code=${String(loginValue.deviceCode)} url=${String(loginValue.verificationUrl)}`,
      login.status === 200 && loginValue.deviceCode === 'stub-device' && String(loginValue.verificationUrl).startsWith('https://')
    )

    const poll = await postJson('/sync/login/poll', { deviceCode: 'stub-device' })
    check(
      'S5',
      '轮询登录状态',
      '200 且 ready=false',
      `status=${poll.status} ready=${poll.payload.value?.ready} waiter=${poll.payload.value?.waiterState}`,
      poll.status === 200 && poll.payload.value?.ready === false
    )

    process.env.STUB_LARK_USER = 'ready'
    const lists = await getJson('/sync/tasklists')
    check(
      'S6',
      '登录后能读到清单列表',
      '200 且返回 2 个清单',
      `status=${lists.status} count=${lists.payload.value?.count}`,
      lists.status === 200 && lists.payload.value?.count === 2
    )

    const saved = await postJson('/sync/config', {
      lists: {
        'urgent-important': 'g_urgent',
        'urgent-not-important': 'g_a',
        'not-urgent-important': 'g_b',
        'not-urgent-not-important': 'g_c'
      },
      intervalMinutes: 15
    })
    check(
      'S7',
      '保存四个象限的清单映射',
      '200 且 missing 为空',
      `status=${saved.status} missing=${JSON.stringify(saved.payload.value?.missing)}`,
      saved.status === 200 && Array.isArray(saved.payload.value?.missing) && saved.payload.value.missing.length === 0
    )

    const onDisk = JSON.parse(await fsp.readFile(configPath, 'utf8'))
    const statusAfter = (await getJson('/sync/status')).payload.value ?? {}
    check(
      'S8',
      '配置落盘并能被状态接口读回',
      '文件内 4 个清单 + intervalMinutes=15',
      `file=${Object.keys(onDisk.lists ?? {}).length} readBack=${Object.keys(statusAfter.config?.lists ?? {}).length} interval=${onDisk.intervalMinutes}`,
      Object.keys(onDisk.lists ?? {}).length === 4 && Object.keys(statusAfter.config?.lists ?? {}).length === 4 && onDisk.intervalMinutes === 15
    )

    const autoOn = statusAfter.autoSync ?? {}
    check(
      'S14',
      '启用定时同步后状态里带间隔',
      'enabled=true 且 intervalMinutes=15',
      `enabled=${autoOn.enabled} interval=${autoOn.intervalMinutes}`,
      autoOn.enabled === true && autoOn.intervalMinutes === 15
    )

    await postJson('/sync/config', { intervalMinutes: null })
    const autoOff = (await getJson('/sync/status')).payload.value?.autoSync ?? {}
    check(
      'S15',
      '关闭定时同步',
      'enabled=false',
      `enabled=${autoOff.enabled}`,
      autoOff.enabled === false
    )

    const badQuadrant = await postJson('/sync/config', { lists: { 'no-such-quadrant': 'g_x' } })
    check('S9', '未知象限被拒绝', '400', `status=${badQuadrant.status}`, badQuadrant.status === 400)

    await fsp.rm(configPath, { force: true })
    const created = await postJson('/sync/tasklists/create', {})
    const createdValue = created.payload.value ?? {}
    check(
      'S10',
      '一键创建四个飞书清单并写入映射',
      '200 且 created 4 个、配置里 4 个清单',
      `status=${created.status} created=${createdValue.created?.length} lists=${Object.keys(createdValue.config?.lists ?? {}).length}`,
      created.status === 200 && createdValue.created?.length === 4 && Object.keys(createdValue.config?.lists ?? {}).length === 4
    )

    const run = await postJson('/sync/run', { dryRun: true })
    check(
      'S11',
      '从界面触发同步（预演）',
      '200 且统计行含「预演」',
      `status=${run.status} summary=${run.payload.value?.summary}`,
      run.status === 200 && String(run.payload.value?.summary ?? '').includes('预演')
    )

    await fsp.writeFile(configPath, '{ broken', 'utf8')
    const brokenStatus = await getJson('/sync/status')
    check(
      'S12',
      '损坏的同步配置不阻断状态接口',
      '200 且 config.error 非空',
      `status=${brokenStatus.status} error=${brokenStatus.payload.value?.config?.error}`,
      brokenStatus.status === 200 && typeof brokenStatus.payload.value?.config?.error === 'string'
    )

    process.env.LARK_CLI = '/nonexistent/lark-cli'
    const notInstalled = await getJson('/sync/status')
    check(
      'S13',
      '未安装 lark-cli 时的降级',
      '200 且 installed=false',
      `status=${notInstalled.status} installed=${notInstalled.payload.value?.cli?.installed}`,
      notInstalled.status === 200 && notInstalled.payload.value?.cli?.installed === false
    )
    // S16：换象限要落成"先进目标清单、再从原清单移出"两步
    {
      process.env.LARK_CLI = stub
      process.env.STUB_LARK_USER = 'ready'
      const callLog = path.join(dataDir, 'lark-calls.ndjson')
      await fsp.rm(callLog, { force: true })
      process.env.STUB_LARK_LOG = callLog
      const taskGuid = 'gtask_move'
      process.env.STUB_LARK_DATA = JSON.stringify({
        lists: { g_urgent: [taskGuid], g_a: [], g_b: [], g_c: [] },
        tasks: {
          [taskGuid]: {
            guid: taskGuid,
            summary: 'S16 待办',
            description: '',
            completed_at: '0',
            updated_at: '2026-01-01T00:00:00+08:00'
          }
        }
      })
      await fsp.writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          lists: { 'urgent-important': 'g_urgent', 'urgent-not-important': 'g_a', 'not-urgent-important': 'g_b', 'not-urgent-not-important': 'g_c' },
          intervalMinutes: null
        }),
        'utf8'
      )
      const made = await postJson('/create', { title: 'S16 待办', quadrant: 'urgent-important' })
      const todoId = made.payload.value?.upserted?.[0]?.id
      const same = { title: 'S16 待办', description: '', dueAt: null, done: false, completedAt: null }
      await fsp.writeFile(
        statePath,
        JSON.stringify({ version: 1, items: { [todoId]: { guid: taskGuid, quadrant: 'urgent-important', dsh: same, lark: same, syncedAt: '2026-01-01T00:00:00.000Z' } } }),
        'utf8'
      )
      await postJson('/setQuadrant', { ids: [todoId], quadrant: 'not-urgent-important' })
      // 必须异步起子进程：宿主 HTTP 服务就在本进程里，同步阻塞会把自己锁死
      const moved = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(here, '../../scripts/feishu-sync.mjs'), '--api', base, '--data-dir', dataDir], {
          env: { ...process.env }
        })
        let text = ''
        child.stdout.on('data', (chunk) => { text += chunk })
        child.stderr.on('data', (chunk) => { text += chunk })
        child.on('close', (code) => resolve({ code, stdout: text }))
      })
      const calls = (await fsp.readFile(callLog, 'utf8')).trim().split('\n').map((line) => line)
      const addIndex = calls.findIndex((line) => line.includes('add_tasklist') && line.includes('g_b'))
      const removeIndex = calls.findIndex((line) => line.includes('remove_tasklist') && line.includes('g_urgent'))
      const onDiskState = JSON.parse(await fsp.readFile(statePath, 'utf8'))
      check(
        'S16',
        '换象限：先进新清单再从原清单移出',
        '推送 1，且 add_tasklist 早于 remove_tasklist，状态改到新象限',
        `summary=${String(moved.stdout).trim().split('\n').pop()} add=${addIndex} remove=${removeIndex} quadrant=${onDiskState.items[todoId]?.quadrant}`,
        moveSummaryIsPushed(moved.stdout) &&
          addIndex !== -1 &&
          removeIndex !== -1 &&
          addIndex < removeIndex &&
          onDiskState.items[todoId]?.quadrant === 'not-urgent-important'
      )
      delete process.env.STUB_LARK_LOG
      delete process.env.STUB_LARK_DATA
    }


    // S17–S19：同步策略（方向 / 冲突处理）能存能读，且脚本按策略执行
    {
      const saved = await postJson('/sync/config', { strategy: { conflict: 'local', direction: 'push' } })
      const after = (await getJson('/sync/status')).payload.value ?? {}
      const onDiskStrategy = JSON.parse(await fsp.readFile(configPath, 'utf8')).strategy ?? {}
      check(
        'S17',
        '保存同步策略并能读回',
        '200 且 conflict=local direction=push',
        `status=${saved.status} conflict=${after.config?.strategy?.conflict} direction=${after.config?.strategy?.direction} file=${onDiskStrategy.conflict}/${onDiskStrategy.direction}`,
        saved.status === 200 &&
          after.config?.strategy?.conflict === 'local' &&
          after.config?.strategy?.direction === 'push' &&
          onDiskStrategy.conflict === 'local' &&
          onDiskStrategy.direction === 'push'
      )

      const badConflict = await postJson('/sync/config', { strategy: { conflict: 'whatever' } })
      const badDirection = await postJson('/sync/config', { strategy: { direction: 'sideways' } })
      const badBody = await postJson('/sync/config', { strategy: 'both' })
      check(
        'S18',
        '非法同步策略被拒绝',
        '400 且提示具体字段',
        `conflict=${badConflict.status} direction=${badDirection.status} body=${badBody.status}`,
        badConflict.status === 400 &&
          badDirection.status === 400 &&
          badBody.status === 400 &&
          String(badConflict.payload?.error ?? '').includes('冲突策略') &&
          String(badDirection.payload?.error ?? '').includes('同步方向')
      )

      // 只推送模式：飞书里有、本地没有的任务不该被拉进来
      process.env.LARK_CLI = stub
      process.env.STUB_LARK_USER = 'ready'
      const strayGuid = 'gtask_stray'
      process.env.STUB_LARK_DATA = JSON.stringify({
        lists: { g_urgent: [], g_a: [strayGuid], g_b: [], g_c: [] },
        tasks: {
          [strayGuid]: {
            guid: strayGuid,
            summary: '飞书独有任务',
            description: '',
            completed_at: '0',
            updated_at: '2026-01-02T00:00:00+08:00'
          }
        }
      })
      const localTodos = (await getJson('/snapshot')).payload.value?.todos ?? []
      const localIds = localTodos.filter((todo) => todo.parentId === null).map((todo) => todo.id)
      if (localIds.length > 0) await postJson('/remove', { ids: localIds })
      const pushed = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(here, '../../scripts/feishu-sync.mjs'), '--api', base, '--data-dir', dataDir], {
          env: { ...process.env }
        })
        let text = ''
        child.stdout.on('data', (chunk) => { text += chunk })
        child.stderr.on('data', (chunk) => { text += chunk })
        child.on('close', (code) => resolve({ code, stdout: text }))
      })
      const pulledTodos = ((await getJson('/snapshot')).payload.value?.todos ?? []).filter((todo) => todo.parentId === null)
      check(
        'S19',
        '只推送模式不拉取飞书独有的任务',
        '摘要「拉取 0」且本地没有新增待办',
        `summary=${String(pushed.stdout).trim().split('\n').pop()} todos=${pulledTodos.length}`,
        String(pushed.stdout).includes('拉取 0') && pulledTodos.length === 0
      )
      delete process.env.STUB_LARK_DATA
      await postJson('/sync/config', { strategy: { conflict: 'newer', direction: 'both' } })

      // S20：两侧都改过时，冲突策略选「以本地为准」，即使飞书更新更晚也推本地
      process.env.LARK_CLI = stub
      process.env.STUB_LARK_USER = 'ready'
      const clashGuid = 'gtask_clash'
      process.env.STUB_LARK_DATA = JSON.stringify({
        lists: { g_urgent: [clashGuid], g_a: [], g_b: [], g_c: [] },
        tasks: {
          [clashGuid]: {
            guid: clashGuid,
            summary: '飞书侧改过的标题',
            description: '',
            completed_at: '0',
            updated_at: '2026-02-01T00:00:00+08:00'
          }
        }
      })
      const clash = await postJson('/create', { title: '本地侧改过的标题', quadrant: 'urgent-important' })
      const clashId = clash.payload.value?.upserted?.[0]?.id
      const oldSnapshot = { title: '原始标题', description: '', dueAt: null, done: false, completedAt: null }
      await fsp.writeFile(
        statePath,
        JSON.stringify({ version: 1, items: { [clashId]: { guid: clashGuid, quadrant: 'urgent-important', dsh: oldSnapshot, lark: oldSnapshot, syncedAt: '2026-01-01T00:00:00.000Z' } } }),
        'utf8'
      )
      await postJson('/sync/config', { strategy: { conflict: 'local', direction: 'both' } })
      const preferred = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(here, '../../scripts/feishu-sync.mjs'), '--api', base, '--data-dir', dataDir], {
          env: { ...process.env }
        })
        let text = ''
        child.stdout.on('data', (chunk) => { text += chunk })
        child.stderr.on('data', (chunk) => { text += chunk })
        child.on('close', (code) => resolve({ code, stdout: text }))
      })
      const clashTodos = (await getJson('/snapshot')).payload.value?.todos ?? []
      const clashTodo = clashTodos.find((todo) => todo.id === clashId)
      check(
        'S20',
        '冲突策略选「以本地为准」时推本地而不是拉飞书',
        '摘要含「冲突 1」且摘要为「推送 1」，本地标题不变',
        `summary=${String(preferred.stdout).trim().split('\n').pop()} title=${clashTodo?.title}`,
        String(preferred.stdout).includes('冲突 1') &&
          moveSummaryIsPushed(preferred.stdout) === true &&
          clashTodo?.title === '本地侧改过的标题'
      )
      delete process.env.STUB_LARK_DATA
      await postJson('/sync/config', { strategy: { conflict: 'newer', direction: 'both' } })
    }

  } finally {
    if (previousCli === undefined) delete process.env.LARK_CLI
    else process.env.LARK_CLI = previousCli
    if (previousUser === undefined) delete process.env.STUB_LARK_USER
    else process.env.STUB_LARK_USER = previousUser
    await fsp.rm(configPath, { force: true })
    await fsp.rm(statePath, { force: true })
    await fsp.rm(logPath, { force: true })
  }
}

server.close()
await fsp.rm(dataDir, { recursive: true, force: true })

const failed = results.filter((item) => item.pass !== true)
console.log('')
console.log(`共 ${results.length} 项，失败 ${failed.length}`)
if (failed.length > 0) {
  for (const item of failed) {
    console.log(`  fail ${item.name} ${item.description}`)
    console.log(`       期望: ${item.expected}`)
    console.log(`       实际: ${item.actual}`)
  }
}
process.exitCode = failed.length
