import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-4quadrant-todo'
export const inject = ['webServer']

// 18 条 exact 路由都挂在该前缀之下
// GET  /snapshot /reminders /export
// POST /create /update /complete /reopen /remove /setQuadrant /setCollapsed /fromConversation
//      /snooze /duplicateRecurrence /filterSave /filterRemove /import /import/undo /upgrade
const ROUTE = '/plugins/dsh-4quadrant-todo'
const WRITE_HEADER = 'x-dsh-todo'
const DATA_VERSION = 2
const ACCEPTED_VERSIONS = new Set([1, 2])
const TITLE_MAX = 200
const DESCRIPTION_MAX = 20000
const TAGS_MAX = 10
const TAG_LENGTH_MAX = 20
const TODOS_MAX = 20000
const FILTERS_MAX = 20
const FILTER_NAME_MAX = 40
const KEYWORD_MAX = 100
const RECURRENCE_INTERVAL_MAX = 12
const BODY_MAX_BYTES = 1024 * 1024
const IMPORT_BODY_MAX_BYTES = 32 * 1024 * 1024
const REMINDER_SCAN_INTERVAL_MS = 30000
const REMINDER_FIRST_SCAN_DELAY_MS = 5000
const SNOOZE_MINUTES = 10
const DEFAULT_QUADRANT = 'urgent-important'
const READONLY_MESSAGE = '数据格式为 1.0，请先升级'
const IMPORT_BACKUP_PREFIX = 'todos.before-import-'
const V1_BACKUP_PREFIX = 'todos.v1-'
const BACKUP_NAME_PATTERN = /^todos\.(?:before-import|v1)-\d{8}-\d{6}(?:-\d+)?\.json$/
const IMPORT_BACKUP_PATTERN = /^todos\.before-import-\d{8}-\d{6}(?:-\d+)?\.json$/

const QUADRANTS = new Set([
  'urgent-important',
  'urgent-not-important',
  'not-urgent-important',
  'not-urgent-not-important'
])
const ENTRY_TYPES = new Set(['question', 'approval'])
const FREQUENCIES = new Set(['daily', 'weekly', 'monthly'])
const LEAD_MINUTES = new Set([0, 5, 15, 30, 60, 1440])
const STATS_RANGES = new Set(['week', 'month', 'quarter', 'custom'])
const DUE_STATES = new Set(['all', 'overdue', 'notOverdue', 'noDue'])
const DUE_RANGE_KINDS = new Set(['any', 'today', 'week', 'range'])
const SOURCE_FILTERS = new Set(['all', 'manual', 'conversation'])
const DEFAULT_SETTINGS = { reminderLeadMinutes: 30, statsRange: 'week' }

// ISO 8601 时间，末尾带时区标识
const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

class TodoError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'TodoError'
    this.status = status
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function countChars(value) {
  return [...value].length
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function sendOk(res, value) {
  sendJson(res, 200, { ok: true, value })
}

function sendFail(res, status, message) {
  sendJson(res, status, { ok: false, error: message })
}

function requireText(raw, label) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new TodoError(400, `${label}必须是非空字符串`)
  return raw.trim()
}

function requireId(raw) {
  return requireText(raw, '待办标识')
}

function parseIds(raw) {
  if (!Array.isArray(raw)) throw new TodoError(400, '待办标识必须是数组')
  if (raw.length === 0) throw new TodoError(400, '待办标识不能为空数组')
  return raw.map((item) => requireId(item))
}

function parseTitle(raw) {
  if (typeof raw !== 'string') throw new TodoError(400, '标题必须是字符串')
  const title = raw.trim()
  if (title === '') throw new TodoError(400, '标题不能为空')
  if (countChars(title) > TITLE_MAX) throw new TodoError(400, `标题不能超过 ${TITLE_MAX} 字`)
  return title
}

// 描述缺省为空字符串，保留原有换行
function parseDescription(raw) {
  if (raw === undefined || raw === null) return ''
  return parseRequiredDescription(raw)
}

function parseRequiredDescription(raw) {
  if (typeof raw !== 'string') throw new TodoError(400, '描述必须是字符串')
  if (countChars(raw) > DESCRIPTION_MAX) throw new TodoError(400, `描述不能超过 ${DESCRIPTION_MAX} 字`)
  return raw
}

function requireQuadrant(raw) {
  if (typeof raw !== 'string' || !QUADRANTS.has(raw)) throw new TodoError(400, `象限取值不合法: ${String(raw)}`)
  return raw
}

function optionalQuadrant(raw, fallback) {
  if (raw === undefined || raw === null) return fallback
  return requireQuadrant(raw)
}

function parseIsoText(raw, label) {
  if (typeof raw !== 'string') throw new TodoError(400, `${label}必须是字符串`)
  const value = raw.trim()
  if (!ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TodoError(400, `${label}必须是带时区标识的 ISO 8601 时间: ${value}`)
  }
  return value
}

function parseDueAt(raw) {
  if (raw === undefined || raw === null) return null
  return parseIsoText(raw, '计划截止时间')
}

function parseParentId(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') throw new TodoError(400, '父待办标识必须是字符串')
  return raw.trim()
}

function parseWorkspaceId(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') throw new TodoError(400, '工作区标识必须是字符串')
  return raw
}

function requireEntryType(raw) {
  if (typeof raw !== 'string' || !ENTRY_TYPES.has(raw)) throw new TodoError(400, `来源类型取值不合法: ${String(raw)}`)
  return raw
}

function parseSource(raw) {
  if (raw === undefined || raw === null) return { kind: 'manual' }
  if (!isPlainObject(raw)) throw new TodoError(400, '来源必须是对象')
  if (raw.kind === 'manual') return { kind: 'manual' }
  if (raw.kind !== 'conversation') throw new TodoError(400, `来源类型取值不合法: ${String(raw.kind)}`)
  return {
    kind: 'conversation',
    sessionId: requireText(raw.sessionId, '来源会话标识'),
    entryId: requireText(raw.entryId, '来源条目标识'),
    entryType: requireEntryType(raw.entryType)
  }
}

function sourceKeyOf(source) {
  if (source.kind !== 'conversation') return null
  return `${source.sessionId}:${source.entryId}:${source.entryType}`
}

// 来源去重只匹配顶层待办，子待办继承父任务的 sourceKey 但不参与判定
function findTopBySourceKey(todos, sourceKey) {
  return todos.find((item) => item.parentId === null && item.sourceKey === sourceKey)
}

// 标签规范化：去首尾空白、丢弃空项、按首次出现去重、保持顺序
function normalizeTags(raw, label) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new TodoError(400, `${label}必须是字符串数组`)
  const seen = new Set()
  const tags = []
  for (const item of raw) {
    if (typeof item !== 'string') throw new TodoError(400, `${label}的每一项必须是字符串`)
    if (item.includes('\n') || item.includes('\r')) throw new TodoError(400, `${label}不能包含换行`)
    const tag = item.trim()
    if (tag === '') continue
    if (countChars(tag) > TAG_LENGTH_MAX) throw new TodoError(400, `${label}的单项不能超过 ${TAG_LENGTH_MAX} 字`)
    if (seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  if (tags.length > TAGS_MAX) throw new TodoError(400, `${label}不能超过 ${TAGS_MAX} 个`)
  return tags
}

function parseRecurrence(raw) {
  if (raw === undefined || raw === null) return null
  if (!isPlainObject(raw)) throw new TodoError(400, '重复设置必须是对象')
  if (typeof raw.freq !== 'string' || !FREQUENCIES.has(raw.freq)) {
    throw new TodoError(400, `重复设置的频率取值不合法: ${String(raw.freq)}`)
  }
  if (!Number.isInteger(raw.interval) || raw.interval < 1 || raw.interval > RECURRENCE_INTERVAL_MAX) {
    throw new TodoError(400, `重复设置的间隔必须是 1 至 ${RECURRENCE_INTERVAL_MAX} 的整数`)
  }
  const until = raw.until === undefined || raw.until === null ? null : parseIsoText(raw.until, '重复设置的终止时间')
  return { freq: raw.freq, interval: raw.interval, until }
}

// present 用于区分「未传」与「显式传 null 取消提醒」
function parseReminder(raw, settings) {
  if (raw === undefined) return { present: false, value: undefined }
  if (raw === null) return { present: true, value: null }
  if (!isPlainObject(raw)) throw new TodoError(400, '提醒设置必须是对象')
  const leadMinutes = raw.leadMinutes === undefined || raw.leadMinutes === null
    ? settings.reminderLeadMinutes
    : raw.leadMinutes
  if (!LEAD_MINUTES.has(leadMinutes)) {
    throw new TodoError(400, `提醒提前量取值不合法: ${String(leadMinutes)}`)
  }
  const snoozeUntil = raw.snoozeUntil === undefined || raw.snoozeUntil === null
    ? null
    : parseIsoText(raw.snoozeUntil, '提醒的稍后时间')
  return { present: true, value: { leadMinutes, snoozeUntil } }
}

function requireLocalDate(raw, label) {
  if (typeof raw !== 'string' || !LOCAL_DATE_PATTERN.test(raw)) {
    throw new TodoError(400, `${label}必须是 YYYY-MM-DD 格式的日期`)
  }
  const parsed = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) throw new TodoError(400, `${label}不是合法日期: ${raw}`)
  return raw
}

function normalizeDueRange(raw, label) {
  if (raw === undefined || raw === null) return { kind: 'any', from: null, to: null }
  if (!isPlainObject(raw)) throw new TodoError(400, `${label}必须是对象`)
  const kind = raw.kind === undefined || raw.kind === null ? 'any' : raw.kind
  if (!DUE_RANGE_KINDS.has(kind)) throw new TodoError(400, `${label}的类型取值不合法: ${String(kind)}`)
  if (kind !== 'range') return { kind, from: null, to: null }
  const from = requireLocalDate(raw.from, `${label}的起始日期`)
  const to = requireLocalDate(raw.to, `${label}的结束日期`)
  if (from > to) throw new TodoError(400, `${label}的起始日期不能晚于结束日期`)
  return { kind, from, to }
}

function normalizeConditions(raw, label) {
  const value = raw === undefined || raw === null ? {} : raw
  if (!isPlainObject(value)) throw new TodoError(400, `${label}必须是对象`)
  const tags = normalizeTags(value.tags, `${label}的标签`)
  const quadrants = []
  if (value.quadrants !== undefined && value.quadrants !== null) {
    if (!Array.isArray(value.quadrants)) throw new TodoError(400, `${label}的象限必须是数组`)
    for (const item of value.quadrants) quadrants.push(requireQuadrant(item))
  }
  const dueState = value.dueState === undefined || value.dueState === null ? 'all' : value.dueState
  if (!DUE_STATES.has(dueState)) throw new TodoError(400, `${label}的到期状态取值不合法: ${String(dueState)}`)
  const dueRange = normalizeDueRange(value.dueRange, `${label}的到期范围`)
  const source = value.source === undefined || value.source === null ? 'all' : value.source
  if (!SOURCE_FILTERS.has(source)) throw new TodoError(400, `${label}的来源取值不合法: ${String(source)}`)
  const keyword = value.keyword === undefined || value.keyword === null ? '' : value.keyword
  if (typeof keyword !== 'string') throw new TodoError(400, `${label}的关键词必须是字符串`)
  if (countChars(keyword) > KEYWORD_MAX) throw new TodoError(400, `${label}的关键词不能超过 ${KEYWORD_MAX} 字`)
  return { tags, quadrants, dueState, dueRange, source, keyword }
}

function newId() {
  return `t_${randomUUID()}`
}

function newSeriesId() {
  return `s_${randomUUID()}`
}

function newFilterId() {
  return `f_${randomUUID()}`
}

// dataDir 覆盖默认数据目录，缺省为 <DSH_HOME>/four-quadrant-todo
function resolveDataDir(config) {
  const override = typeof config.dataDir === 'string' ? config.dataDir.trim() : ''
  if (override !== '') return path.resolve(override)
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  return path.resolve(home, 'four-quadrant-todo')
}

function emptyData() {
  return {
    version: DATA_VERSION,
    todos: [],
    collapsed: {},
    filters: [],
    settings: { ...DEFAULT_SETTINGS },
    meta: { upgradedAt: null, upgradedFrom: null }
  }
}

function emptyTodoFields() {
  return {
    tags: [],
    recurrence: null,
    seriesId: null,
    generatedFromId: null,
    reminder: null,
    remindedAt: null,
    startedSessionId: null,
    startedAt: null
  }
}

// 版本 1 的文件只在内存里补齐 2.0 字段，原文件字节不变
function padToVersion2(raw) {
  const todos = raw.todos.map((todo) => {
    const padded = { ...todo }
    for (const [field, fallback] of Object.entries(emptyTodoFields())) {
      if (!Object.hasOwn(padded, field)) padded[field] = fallback
    }
    return padded
  })
  const settings = isPlainObject(raw.settings)
    ? { ...DEFAULT_SETTINGS, ...raw.settings }
    : { ...DEFAULT_SETTINGS }
  return {
    version: DATA_VERSION,
    todos,
    collapsed: raw.collapsed,
    filters: Array.isArray(raw.filters) ? raw.filters : [],
    settings,
    meta: isPlainObject(raw.meta) ? raw.meta : { upgradedAt: null, upgradedFrom: null }
  }
}

function stampOf(date) {
  const pad = (value) => String(value).padStart(2, '0')
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${day}-${time}`
}

// 时间字符串的日期部分按原时区标识推进，避免受进程时区影响
function splitIso(text) {
  const match = ISO_PATTERN.exec(text)
  if (match === null) throw new TodoError(400, `时间格式不合法: ${text}`)
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    offset: match[7]
  }
}

function joinIso(parts) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const offset = parts.offset === 'Z' ? 'Z' : parts.offset
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:00${offset}`
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

// 按天与按周加自然日，按月加自然月并对月末截断；anchorDay 为序列首条的日号
function shiftDueAt(dueAt, rule, anchorDay = null) {
  const parts = splitIso(dueAt)
  if (rule.freq === 'daily' || rule.freq === 'weekly') {
    const days = rule.freq === 'daily' ? rule.interval : rule.interval * 7
    const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
    return joinIso({
      year: base.getUTCFullYear(),
      month: base.getUTCMonth() + 1,
      day: base.getUTCDate(),
      hour: parts.hour,
      minute: parts.minute,
      offset: parts.offset
    })
  }
  const totalMonths = (parts.year * 12) + (parts.month - 1) + rule.interval
  const year = Math.floor(totalMonths / 12)
  const month = (totalMonths % 12) + 1
  const day = Math.min(anchorDay ?? parts.day, daysInMonth(year, month))
  return joinIso({ year, month, day, hour: parts.hour, minute: parts.minute, offset: parts.offset })
}

export function apply(ctx, config) {
  const pluginConfig = config ?? {}
  const dataDir = resolveDataDir(pluginConfig)
  const dataFile = path.join(dataDir, 'todos.json')

  const webServer = ctx.get('webServer')
  if (webServer === undefined || webServer === null) throw new Error('dsh-4quadrant-todo: webServer 服务不可用')

  const timer = ctx.get('timer')
  if (timer === undefined || timer === null) throw new Error('dsh-4quadrant-todo: timer 服务不可用')

  // 全部写操作挂在同一条 Promise 链上，前一个结束后才执行下一个
  let writeQueue = Promise.resolve()
  let tempSeq = 0
  let scanRunning = false

  function enqueue(task) {
    const result = writeQueue.then(task)
    // 链本身接住失败，调用方仍然收到同一个拒绝
    writeQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  // 数据文件自身的结构错误带绝对路径，导入内容的结构错误按 400 返回
  function fileFail(detail) {
    throw new TodoError(500, `数据文件结构不合法: ${dataFile}，${detail}`)
  }

  function importFail(detail) {
    throw new TodoError(400, detail)
  }

  function assertIsoField(value, fail, at, field) {
    if (value === null) return
    if (typeof value !== 'string' || !ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
      fail(`${at}的 ${field} 必须是 null 或带时区标识的 ISO 8601 字符串`)
    }
  }

  function assertTextField(value, fail, at, field) {
    if (value === null) return
    if (typeof value !== 'string' || value === '') fail(`${at}的 ${field} 必须是 null 或非空字符串`)
  }

  function assertSourceField(source, fail, at) {
    if (!isPlainObject(source)) fail(`${at}的 source 必须是对象`)
    if (source.kind === 'manual') {
      if (Object.keys(source).length !== 1) fail(`${at}的 source 只允许 kind 一个字段`)
      return
    }
    if (source.kind !== 'conversation') fail(`${at}的 source.kind 不合法`)
    for (const field of ['sessionId', 'entryId']) {
      if (typeof source[field] !== 'string' || source[field] === '') {
        fail(`${at}的 source.${field} 必须是非空字符串`)
      }
    }
    if (!ENTRY_TYPES.has(source.entryType)) fail(`${at}的 source.entryType 不合法`)
  }

  function assertTagsField(tags, fail, at) {
    if (!Array.isArray(tags)) fail(`${at}的 tags 必须是数组`)
    if (tags.length > TAGS_MAX) fail(`${at}的 tags 不能超过 ${TAGS_MAX} 个`)
    const seen = new Set()
    for (const tag of tags) {
      if (typeof tag !== 'string' || tag === '') fail(`${at}的 tags 含有空项或非字符串项`)
      if (tag !== tag.trim()) fail(`${at}的 tags 含首尾空白的项: ${tag}`)
      if (countChars(tag) > TAG_LENGTH_MAX) fail(`${at}的 tags 单项超过 ${TAG_LENGTH_MAX} 字: ${tag}`)
      if (seen.has(tag)) fail(`${at}的 tags 含有重复项: ${tag}`)
      seen.add(tag)
    }
  }

  function assertRecurrenceField(rule, fail, at) {
    if (rule === null) return
    if (!isPlainObject(rule)) fail(`${at}的 recurrence 必须是 null 或对象`)
    if (typeof rule.freq !== 'string' || !FREQUENCIES.has(rule.freq)) fail(`${at}的 recurrence.freq 不合法`)
    if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > RECURRENCE_INTERVAL_MAX) {
      fail(`${at}的 recurrence.interval 必须是 1 至 ${RECURRENCE_INTERVAL_MAX} 的整数`)
    }
    assertIsoField(rule.until, fail, at, 'recurrence.until')
  }

  function assertReminderField(reminder, fail, at) {
    if (reminder === null) return
    if (!isPlainObject(reminder)) fail(`${at}的 reminder 必须是 null 或对象`)
    if (!LEAD_MINUTES.has(reminder.leadMinutes)) fail(`${at}的 reminder.leadMinutes 不合法`)
    assertIsoField(reminder.snoozeUntil, fail, at, 'reminder.snoozeUntil')
  }

  function assertTodo(todo, index, fail) {
    const at = `第 ${index + 1} 条待办`
    if (!isPlainObject(todo)) fail(`${at}必须是对象`)
    if (typeof todo.id !== 'string' || todo.id === '') fail(`${at}的 id 不合法`)
    if (typeof todo.title !== 'string') fail(`${at}的 title 不合法`)
    if (typeof todo.description !== 'string') fail(`${at}的 description 不合法`)
    if (!QUADRANTS.has(todo.quadrant)) fail(`${at}的 quadrant 不合法`)
    if (todo.status !== 'open' && todo.status !== 'done') fail(`${at}的 status 不合法`)
    if (todo.parentId !== null && typeof todo.parentId !== 'string') fail(`${at}的 parentId 不合法`)
    if (typeof todo.createdAt !== 'string' || Number.isNaN(Date.parse(todo.createdAt))) fail(`${at}的 createdAt 不合法`)
    assertIsoField(todo.dueAt, fail, at, 'dueAt')
    assertIsoField(todo.completedAt, fail, at, 'completedAt')
    if (todo.status === 'done' && todo.completedAt === null) fail(`${at}已完成但缺少 completedAt`)
    if (todo.status === 'open' && todo.completedAt !== null) fail(`${at}未完成却有 completedAt`)
    if (todo.workspaceId !== null && typeof todo.workspaceId !== 'string') fail(`${at}的 workspaceId 必须是 null 或字符串`)
    assertSourceField(todo.source, fail, at)
    if (todo.sourceKey !== null && typeof todo.sourceKey !== 'string') fail(`${at}的 sourceKey 必须是 null 或字符串`)
    const expectedKey = sourceKeyOf(todo.source)
    if (todo.sourceKey !== expectedKey) fail(`${at}的 sourceKey 与来源不一致，期望 ${String(expectedKey)}，实际 ${String(todo.sourceKey)}`)
    assertTagsField(todo.tags, fail, at)
    assertRecurrenceField(todo.recurrence, fail, at)
    assertTextField(todo.seriesId, fail, at, 'seriesId')
    assertTextField(todo.generatedFromId, fail, at, 'generatedFromId')
    assertReminderField(todo.reminder, fail, at)
    assertIsoField(todo.remindedAt, fail, at, 'remindedAt')
    assertTextField(todo.startedSessionId, fail, at, 'startedSessionId')
    assertIsoField(todo.startedAt, fail, at, 'startedAt')
    if ((todo.startedSessionId === null) !== (todo.startedAt === null)) fail(`${at}的会话标记不完整`)
    if (todo.recurrence !== null && todo.parentId !== null) fail(`${at}是子待办却带重复设置`)
  }

  function assertCollapsed(collapsed, fail) {
    if (!isPlainObject(collapsed)) fail('collapsed 必须是对象')
    for (const scopeKey of Object.keys(collapsed)) {
      const entry = collapsed[scopeKey]
      if (!isPlainObject(entry)) fail(`collapsed.${scopeKey} 必须是对象`)
      for (const quadrant of Object.keys(entry)) {
        if (!QUADRANTS.has(quadrant)) fail(`collapsed.${scopeKey} 的键 ${quadrant} 不是象限标识`)
        if (typeof entry[quadrant] !== 'boolean') fail(`collapsed.${scopeKey}.${quadrant} 必须是布尔值`)
      }
    }
  }

  function assertSettings(settings, fail) {
    if (!isPlainObject(settings)) fail('settings 必须是对象')
    if (!LEAD_MINUTES.has(settings.reminderLeadMinutes)) fail('settings.reminderLeadMinutes 不合法')
    if (!STATS_RANGES.has(settings.statsRange)) fail('settings.statsRange 不合法')
  }

  function assertFilters(filters, fail) {
    if (!Array.isArray(filters)) fail('filters 必须是数组')
    if (filters.length > FILTERS_MAX) fail(`filters 不能超过 ${FILTERS_MAX} 个`)
    const ids = new Set()
    const names = new Set()
    filters.forEach((preset, index) => {
      if (!isPlainObject(preset)) fail(`第 ${index + 1} 个筛选预设必须是对象`)
      if (typeof preset.id !== 'string' || preset.id === '') fail(`第 ${index + 1} 个筛选预设的 id 不合法`)
      if (ids.has(preset.id)) fail(`筛选预设的 id 重复: ${preset.id}`)
      ids.add(preset.id)
      if (typeof preset.name !== 'string' || preset.name.trim() === '') fail(`第 ${index + 1} 个筛选预设的 name 不合法`)
      if (countChars(preset.name) > FILTER_NAME_MAX) fail(`第 ${index + 1} 个筛选预设的 name 超过 ${FILTER_NAME_MAX} 字`)
      if (names.has(preset.name)) fail(`筛选预设的 name 重复: ${preset.name}`)
      names.add(preset.name)
      const conditions = normalizeConditions(preset.conditions, `第 ${index + 1} 个筛选预设的条件`)
      if (JSON.stringify(conditions) !== JSON.stringify(preset.conditions)) {
        fail(`第 ${index + 1} 个筛选预设的条件未规范化`)
      }
      if (typeof preset.createdAt !== 'string' || typeof preset.updatedAt !== 'string') {
        fail(`第 ${index + 1} 个筛选预设缺少创建或更新时间`)
      }
    })
  }

  function assertMeta(meta, fail) {
    if (!isPlainObject(meta)) fail('meta 必须是对象')
    assertIsoField(meta.upgradedAt, fail, 'meta', 'upgradedAt')
    if (meta.upgradedFrom !== null && !ACCEPTED_VERSIONS.has(meta.upgradedFrom)) fail('meta.upgradedFrom 不合法')
  }

  function assertData(data, fail) {
    if (!isPlainObject(data)) fail('顶层必须是对象')
    if (!ACCEPTED_VERSIONS.has(data.version)) fail(`version 必须是 1 或 2，实际 ${String(data.version)}`)
    if (!Array.isArray(data.todos)) fail('todos 必须是数组')
    assertCollapsed(data.collapsed, fail)

    const ids = new Set()
    data.todos.forEach((todo, index) => {
      assertTodo(todo, index, fail)
      if (ids.has(todo.id)) fail(`第 ${index + 1} 条待办的 id 与前面的条目重复: ${todo.id}`)
      ids.add(todo.id)
    })

    const topIds = new Set()
    for (const todo of data.todos) {
      if (todo.parentId === null) topIds.add(todo.id)
    }

    const keys = new Set()
    const seriesKeys = new Set()
    data.todos.forEach((todo, index) => {
      if (todo.parentId !== null && !topIds.has(todo.parentId)) {
        fail(`第 ${index + 1} 条待办的 parentId 未指向存在的顶层待办: ${todo.parentId}`)
      }
      if (todo.generatedFromId !== null && !ids.has(todo.generatedFromId)) {
        fail(`第 ${index + 1} 条待办的 generatedFromId 未指向存在的待办: ${todo.generatedFromId}`)
      }
      if (todo.parentId === null && todo.sourceKey !== null) {
        if (keys.has(todo.sourceKey)) fail(`顶层待办的 sourceKey 重复: ${todo.sourceKey}`)
        keys.add(todo.sourceKey)
      }
      if (todo.parentId === null && todo.seriesId !== null && todo.dueAt !== null) {
        const key = `${todo.seriesId}|${todo.dueAt}`
        if (seriesKeys.has(key)) fail(`顶层待办的重复序列与截止时间组合重复: ${key}`)
        seriesKeys.add(key)
      }
    })

    assertFilters(data.filters, fail)
    assertSettings(data.settings, fail)
    assertMeta(data.meta, fail)
  }

  // 每次写入使用独立的临时文件名，写完重命名覆盖正式文件，失败时清理本次的临时文件
  function nextTempFile() {
    tempSeq += 1
    return path.join(dataDir, `todos.json.${process.pid}.${tempSeq}.tmp`)
  }

  async function removeTempFile(tempFile) {
    try {
      await fsp.rm(tempFile, { force: true })
    } catch (error) {
      console.error(`[dsh-4quadrant-todo] 临时文件清理失败 ${tempFile}: ${messageOf(error)}`)
    }
  }

  async function writeText(text) {
    const tempFile = nextTempFile()
    try {
      await fsp.mkdir(dataDir, { recursive: true })
      await fsp.writeFile(tempFile, text, 'utf8')
      await renameWithRetry(tempFile, dataFile)
    } catch (error) {
      await removeTempFile(tempFile)
      throw new TodoError(500, `数据文件不可写: ${dataFile}，${messageOf(error)}`)
    }
  }

  // Windows 上杀毒软件与索引服务会短暂占用文件，重命名偶发失败，这里按间隔重试几次再报错
  async function renameWithRetry(from, to) {
    const attempts = 8
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await fsp.rename(from, to)
        return
      } catch (error) {
        const code = error?.code
        const busy = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
        if (busy === false || attempt === attempts) throw error
        await new Promise((resolve) => setTimeout(resolve, 40 * attempt))
      }
    }
  }

  // 写回 2.0 结构：先按文件级校验，再序列化
  async function writeData(data) {
    assertData(data, fileFail)
    if (data.version !== DATA_VERSION) throw new TodoError(500, `写回时版本必须是 ${DATA_VERSION}，实际 ${String(data.version)}`)
    await writeText(`${JSON.stringify(data, null, 2)}\n`)
  }

  // 导入内容按 400 校验，作为候选数据先验证再写
  function assertImportCandidate(candidate) {
    assertData(candidate, importFail)
    for (const todo of candidate.todos) {
      if (todo.title.trim() === '' || countChars(todo.title) > TITLE_MAX) importFail(`导入条目的标题不合法: ${todo.id}`)
      if (countChars(todo.description) > DESCRIPTION_MAX) importFail(`导入条目的描述超过 ${DESCRIPTION_MAX} 字: ${todo.id}`)
    }
    return candidate
  }

  async function copyBackup(prefix) {
    const stamp = stampOf(new Date())
    const backupFile = `${prefix}${stamp}.json`
    const target = path.join(dataDir, backupFile)
    try {
      await fsp.copyFile(dataFile, target)
    } catch (error) {
      throw new TodoError(500, `备份文件写入失败: ${target}，${messageOf(error)}`)
    }
    return backupFile
  }

  // 读取正式文件；文件不存在时返回 null
  async function readExisting() {
    let text
    try {
      text = await fsp.readFile(dataFile, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw new TodoError(500, `数据文件不可读: ${dataFile}，${messageOf(error)}`)
    }
    let raw
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw new TodoError(500, `数据文件无法解析: ${dataFile}，${messageOf(error)}`)
    }
    if (!isPlainObject(raw)) throw new TodoError(500, `数据文件结构不合法: ${dataFile}，顶层必须是对象`)
    if (!ACCEPTED_VERSIONS.has(raw.version)) {
      throw new TodoError(500, `数据文件版本不受支持: ${dataFile}，实际 ${String(raw.version)}，允许 1 或 2`)
    }
    const rawVersion = raw.version
    const data = rawVersion === 1 ? padToVersion2(raw) : raw
    assertData(data, fileFail)
    return { data, readOnly: rawVersion === 1 }
  }

  // 读请求使用：文件不存在时在写队列内建立空结构，避免并发读抢同一个临时文件
  async function readStateForRequest() {
    const existing = await readExisting()
    if (existing !== null) return existing
    return enqueue(async () => {
      const created = await readExisting()
      if (created !== null) return created
      const empty = emptyData()
      await writeData(empty)
      return { data: empty, readOnly: false }
    })
  }

  // 写操作使用：调用点已经在写队列内；只读状态下先拒绝
  async function readDataInWrite() {
    const existing = await readExisting()
    if (existing === null) {
      const empty = emptyData()
      await writeData(empty)
      return empty
    }
    if (existing.readOnly) throw new TodoError(400, READONLY_MESSAGE)
    return existing.data
  }

  // 升级、导入与撤销需要读只读文件，因此不做只读拦截
  async function readDataForReplace() {
    const existing = await readExisting()
    if (existing === null) return { data: emptyData(), readOnly: false, exists: false }
    return { data: existing.data, readOnly: existing.readOnly, exists: true }
  }

  async function readJsonBody(req, maxBytes) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > maxBytes) throw new TodoError(400, `请求内容超过 ${maxBytes} 字节上限`)
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.trim() === '') throw new TodoError(400, '请求内容不能为空')
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new TodoError(400, `请求内容不是合法的 JSON: ${messageOf(error)}`)
    }
    if (!isPlainObject(parsed)) throw new TodoError(400, '请求内容必须是 JSON 对象')
    return parsed
  }

  // 写请求先校验写入标记，再读取请求内容，最后排队执行
  async function runWrite(req, res, action, maxBytes = BODY_MAX_BYTES) {
    if (req.headers[WRITE_HEADER] !== '1') {
      sendFail(res, 403, '缺少写入标记')
      return
    }
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      throw new TodoError(400, '写请求必须使用 content-type: application/json')
    }
    const body = await readJsonBody(req, maxBytes)
    sendOk(res, await enqueue(() => action(body)))
  }

  function childTodos(data, parentId) {
    return data.todos.filter((item) => item.parentId === parentId)
  }

  async function createTodo(input) {
    const data = await readDataInWrite()
    const title = parseTitle(input.title)
    const description = parseDescription(input.description)
    const dueAt = parseDueAt(input.dueAt)
    const parentId = parseParentId(input.parentId)
    const createdAt = new Date().toISOString()
    const tags = normalizeTags(input.tags, '标签')
    const recurrence = parseRecurrence(input.recurrence)
    const reminderResult = parseReminder(input.reminder, data.settings)

    let todo
    if (parentId === null) {
      const quadrant = requireQuadrant(input.quadrant)
      const workspaceId = parseWorkspaceId(input.workspaceId)
      const source = parseSource(input.source)
      const sourceKey = sourceKeyOf(source)
      if (sourceKey !== null && recurrence !== null) {
        throw new TodoError(400, '会话来源的待办不接受重复设置')
      }
      // 来源去重是写前不变量：同 sourceKey 的顶层待办最多一条
      if (sourceKey !== null) {
        const existing = findTopBySourceKey(data.todos, sourceKey)
        if (existing !== undefined) {
          throw new TodoError(400, `来源条目已存在: ${sourceKey}，对应待办 ${existing.id}`)
        }
      }
      todo = {
        id: newId(),
        title,
        description,
        quadrant,
        dueAt,
        parentId: null,
        status: 'open',
        createdAt,
        completedAt: null,
        workspaceId,
        source,
        sourceKey,
        tags,
        recurrence,
        seriesId: null,
        generatedFromId: null,
        reminder: reminderResult.present
          ? reminderResult.value
          : { leadMinutes: data.settings.reminderLeadMinutes, snoozeUntil: null },
        remindedAt: null,
        startedSessionId: null,
        startedAt: null
      }
    } else {
      const parent = data.todos.find((item) => item.id === parentId)
      if (parent === undefined) throw new TodoError(400, `父待办不存在: ${parentId}`)
      if (parent.parentId !== null) throw new TodoError(400, `父待办必须是顶层待办: ${parentId}`)
      if (recurrence !== null) throw new TodoError(400, '子待办不接受重复设置')
      if (tags.length > 0) throw new TodoError(400, '子待办的标签只能为空')
      if (reminderResult.present && reminderResult.value !== null) {
        throw new TodoError(400, '子待办不接受提醒设置')
      }
      // 子待办的象限、工作区标识与来源跟随父任务
      todo = {
        id: newId(),
        title,
        description,
        quadrant: parent.quadrant,
        dueAt,
        parentId: parent.id,
        status: 'open',
        createdAt,
        completedAt: null,
        workspaceId: parent.workspaceId,
        source: { ...parent.source },
        sourceKey: sourceKeyOf(parent.source),
        tags,
        recurrence: null,
        seriesId: null,
        generatedFromId: null,
        reminder: null,
        remindedAt: null,
        startedSessionId: null,
        startedAt: null
      }
    }

    data.todos.push(todo)
    await writeData(data)
    return { upserted: [todo], removedIds: [], focusId: todo.id }
  }

  async function updateTodo(input) {
    const data = await readDataInWrite()
    const id = requireId(input.id)
    const todo = data.todos.find((item) => item.id === id)
    if (todo === undefined) throw new TodoError(400, `待办不存在: ${id}`)

    if (Object.hasOwn(input, 'title')) todo.title = parseTitle(input.title)
    if (Object.hasOwn(input, 'description')) todo.description = parseRequiredDescription(input.description)
    if (Object.hasOwn(input, 'dueAt')) {
      todo.dueAt = parseDueAt(input.dueAt)
      todo.remindedAt = null
    }
    if (Object.hasOwn(input, 'tags')) {
      const tags = normalizeTags(input.tags, '标签')
      if (todo.parentId !== null && tags.length > 0) throw new TodoError(400, '子待办的标签只能为空')
      todo.tags = tags
    }
    if (Object.hasOwn(input, 'recurrence')) {
      const recurrence = parseRecurrence(input.recurrence)
      if (recurrence !== null && todo.parentId !== null) throw new TodoError(400, '子待办不接受重复设置')
      todo.recurrence = recurrence
    }
    if (Object.hasOwn(input, 'reminder')) {
      const reminder = parseReminder(input.reminder, data.settings)
      if (reminder.value !== null && todo.parentId !== null) throw new TodoError(400, '子待办不接受提醒设置')
      todo.reminder = reminder.value
      todo.remindedAt = null
    }
    if (Object.hasOwn(input, 'startedSessionId')) {
      todo.startedSessionId = input.startedSessionId === null
        ? null
        : requireText(input.startedSessionId, '会话标识')
    }
    if (Object.hasOwn(input, 'startedAt')) {
      todo.startedAt = input.startedAt === null ? null : parseIsoText(input.startedAt, '发起时间')
    }
    if ((todo.startedSessionId === null) !== (todo.startedAt === null)) {
      throw new TodoError(400, 'startedSessionId 与 startedAt 必须同时传')
    }

    await writeData(data)
    return { upserted: [todo], removedIds: [] }
  }

  // 重复链首条的日号作为按月推进的锚点，月末截断后仍能回到原来的日号
  function seriesAnchorDay(data, todo) {
    let current = todo
    const seen = new Set([todo.id])
    while (current.generatedFromId !== null) {
      const previous = data.todos.find((item) => item.id === current.generatedFromId)
      if (previous === undefined || seen.has(previous.id)) break
      seen.add(previous.id)
      current = previous
    }
    if (current.dueAt === null) return null
    return splitIso(current.dueAt).day
  }

  // 完成一条顶层待办后按重复设置生成下一条实例；原截止时间为空时以完成时刻为基准
  function generateNextInstance(data, todo) {
    const rule = todo.recurrence
    if (rule === null) return null
    const baseDueAt = todo.dueAt === null ? todo.completedAt : todo.dueAt
    if (baseDueAt === null) return null
    if (todo.seriesId === null) todo.seriesId = newSeriesId()
    const nextDue = shiftDueAt(baseDueAt, rule, seriesAnchorDay(data, todo))
    // 终止时间与下一条到期时间相等时仍然生成一次
    if (rule.until !== null && Date.parse(nextDue) > Date.parse(rule.until)) {
      todo.recurrence = null
      return null
    }
    const duplicate = data.todos.find(
      (item) => item.parentId === null && item.id !== todo.id && item.seriesId === todo.seriesId && item.dueAt === nextDue
    )
    if (duplicate !== undefined) return null

    const next = {
      id: newId(),
      title: todo.title,
      description: todo.description,
      quadrant: todo.quadrant,
      dueAt: nextDue,
      parentId: null,
      status: 'open',
      createdAt: new Date().toISOString(),
      completedAt: null,
      workspaceId: todo.workspaceId,
      source: { kind: 'manual' },
      sourceKey: null,
      tags: [...todo.tags],
      recurrence: { freq: rule.freq, interval: rule.interval, until: rule.until },
      seriesId: todo.seriesId,
      generatedFromId: todo.id,
      reminder: todo.reminder === null ? null : { leadMinutes: todo.reminder.leadMinutes, snoozeUntil: null },
      remindedAt: null,
      startedSessionId: null,
      startedAt: null
    }
    data.todos.push(next)

    // 子待办只复制标题，到期时间与完成时间为空
    for (const child of childTodos(data, todo.id)) {
      data.todos.push({
        id: newId(),
        title: child.title,
        description: '',
        quadrant: next.quadrant,
        dueAt: null,
        parentId: next.id,
        status: 'open',
        createdAt: new Date().toISOString(),
        completedAt: null,
        workspaceId: next.workspaceId,
        source: { kind: 'manual' },
        sourceKey: null,
        tags: [],
        recurrence: null,
        seriesId: null,
        generatedFromId: null,
        reminder: null,
        remindedAt: null,
        startedSessionId: null,
        startedAt: null
      })
    }

    return next
  }

  async function completeTodos(input) {
    const data = await readDataInWrite()
    const ids = parseIds(input.ids)
    if (typeof input.includeChildren !== 'boolean') throw new TodoError(400, 'includeChildren 必须是布尔值')
    const includeChildren = input.includeChildren
    const completedAt = new Date().toISOString()
    const changed = new Map()
    const completedTop = []

    function markDone(todo) {
      todo.status = 'done'
      todo.completedAt = completedAt
      changed.set(todo.id, todo)
    }

    for (const id of ids) {
      const todo = data.todos.find((item) => item.id === id)
      if (todo === undefined) throw new TodoError(400, `待办不存在: ${id}`)
      if (todo.status === 'done') continue

      const children = childTodos(data, todo.id)
      const hasOpenChild = children.some((item) => item.status === 'open')
      if (hasOpenChild) {
        if (!includeChildren) throw new TodoError(400, '存在未完成的子待办，需确认合并完成')
        // 父任务与全部子待办共用一个完成时间
        markDone(todo)
        for (const child of children) markDone(child)
        if (todo.parentId === null) completedTop.push(todo)
        continue
      }

      markDone(todo)
      if (todo.parentId === null) {
        completedTop.push(todo)
        continue
      }

      // 子待办由 open 变 done 的这一刻，检查父任务是否随之自动完成
      const parent = data.todos.find((item) => item.id === todo.parentId)
      if (parent === undefined) {
        throw new TodoError(500, `数据文件结构不合法: ${dataFile}，子待办 ${todo.id} 的父待办不存在`)
      }
      if (parent.status === 'done') continue
      const siblings = childTodos(data, parent.id)
      if (!siblings.every((item) => item.status === 'done')) continue
      markDone(parent)
      completedTop.push(parent)
    }

    const recurring = completedTop.filter((item) => item.recurrence !== null)
    if (recurring.length > 0) {
      const doneCount = data.todos.filter((item) => item.status === 'done').length
      if (doneCount >= TODOS_MAX) {
        // 本次完成照常写入，只拒绝生成新实例
        await writeData(data)
        throw new TodoError(400, `已完成记录已达 ${TODOS_MAX} 条上限，请先导出并清理后再完成重复待办`)
      }
      for (const todo of recurring) {
        const next = generateNextInstance(data, todo)
        if (next !== null) changed.set(next.id, next)
      }
    }

    await writeData(data)
    return { upserted: [...changed.values()], removedIds: [] }
  }

  async function reopenTodos(input) {
    const data = await readDataInWrite()
    const ids = parseIds(input.ids)
    const changed = new Map()

    for (const id of ids) {
      const todo = data.todos.find((item) => item.id === id)
      if (todo === undefined) throw new TodoError(400, `待办不存在: ${id}`)
      if (todo.status === 'open') continue
      // 只改本身，不触碰任何子待办，也不触发自动完成
      todo.status = 'open'
      todo.completedAt = null
      todo.remindedAt = null
      changed.set(todo.id, todo)
    }

    await writeData(data)
    return { upserted: [...changed.values()], removedIds: [] }
  }

  async function removeTodos(input) {
    const data = await readDataInWrite()
    const ids = parseIds(input.ids)
    const removed = new Set()

    for (const id of ids) {
      const todo = data.todos.find((item) => item.id === id)
      if (todo === undefined) continue
      removed.add(todo.id)
      // 删除顶层待办时级联删除其全部子待办
      for (const child of childTodos(data, todo.id)) removed.add(child.id)
    }

    // 链中条目被删除后，把它的后继接回更早的条目，链条保持连通
    const previousOf = new Map()
    for (const todo of data.todos) {
      if (removed.has(todo.id)) previousOf.set(todo.id, todo.generatedFromId)
    }
    const survivingSource = (id) => {
      let current = id
      const seen = new Set()
      while (current !== null && removed.has(current) && !seen.has(current)) {
        seen.add(current)
        current = previousOf.get(current) ?? null
      }
      return current
    }

    const changed = new Map()
    if (removed.size > 0) {
      data.todos = data.todos.filter((item) => !removed.has(item.id))
      for (const todo of data.todos) {
        if (todo.generatedFromId === null || !removed.has(todo.generatedFromId)) continue
        todo.generatedFromId = survivingSource(todo.generatedFromId)
        changed.set(todo.id, todo)
      }
    }
    await writeData(data)
    return { upserted: [...changed.values()], removedIds: [...removed] }
  }

  async function setQuadrant(input) {
    const data = await readDataInWrite()
    const ids = parseIds(input.ids)
    const quadrant = requireQuadrant(input.quadrant)
    const changed = new Map()

    for (const id of ids) {
      const todo = data.todos.find((item) => item.id === id)
      if (todo === undefined) throw new TodoError(400, `待办不存在: ${id}`)
      // 子待办的象限只能随父任务变化，单独的请求直接忽略
      if (todo.parentId !== null) continue
      if (todo.quadrant !== quadrant) {
        todo.quadrant = quadrant
        changed.set(todo.id, todo)
      }
      for (const child of childTodos(data, todo.id)) {
        if (child.quadrant === quadrant) continue
        child.quadrant = quadrant
        changed.set(child.id, child)
      }
    }

    await writeData(data)
    return { upserted: [...changed.values()], removedIds: [] }
  }

  async function setCollapsed(input) {
    const data = await readDataInWrite()
    const scopeKey = requireText(input.scopeKey, '工作区标识')
    const quadrant = requireQuadrant(input.quadrant)
    if (typeof input.collapsed !== 'boolean') throw new TodoError(400, 'collapsed 必须是布尔值')

    const current = Object.hasOwn(data.collapsed, scopeKey) ? data.collapsed[scopeKey] : {}
    if (!isPlainObject(current)) {
      throw new TodoError(500, `数据文件结构不合法: ${dataFile}，collapsed.${scopeKey} 必须是对象`)
    }
    data.collapsed = { ...data.collapsed, [scopeKey]: { ...current, [quadrant]: input.collapsed } }

    await writeData(data)
    return { collapsed: data.collapsed }
  }

  async function addFromConversation(input) {
    const data = await readDataInWrite()
    const sessionId = requireText(input.sessionId, '会话标识')
    const entryId = requireText(input.entryId, '来源条目标识')
    const entryType = requireEntryType(input.entryType)
    const sourceKey = `${sessionId}:${entryId}:${entryType}`

    // 来源去重：同 sourceKey 的顶层条目已存在时直接返回它的标识
    const existing = findTopBySourceKey(data.todos, sourceKey)
    if (existing !== undefined) {
      return { upserted: [], removedIds: [], focusId: existing.id, existing: true }
    }

    if (input.recurrence !== undefined && input.recurrence !== null) {
      throw new TodoError(400, '会话来源的待办不接受重复设置')
    }
    if (input.reminder !== undefined) {
      throw new TodoError(400, '会话来源的待办不接受提醒设置')
    }

    const todo = {
      id: newId(),
      title: parseTitle(input.title),
      description: parseDescription(input.description),
      quadrant: optionalQuadrant(input.quadrant, DEFAULT_QUADRANT),
      dueAt: parseDueAt(input.dueAt),
      parentId: null,
      status: 'open',
      createdAt: new Date().toISOString(),
      completedAt: null,
      workspaceId: parseWorkspaceId(input.workspaceId),
      source: { kind: 'conversation', sessionId, entryId, entryType },
      sourceKey,
      tags: normalizeTags(input.tags, '标签'),
      recurrence: null,
      seriesId: null,
      generatedFromId: null,
      reminder: null,
      remindedAt: null,
      startedSessionId: null,
      startedAt: null
    }

    data.todos.push(todo)
    await writeData(data)
    return { upserted: [todo], removedIds: [], focusId: todo.id, existing: false }
  }

  // 一条待办是否到了提醒时间：已完成、子待办、已提醒、稍后未到期、未到提前量都不提醒
  function reminderDue(todo, nowMs) {
    if (todo.status !== 'open' || todo.parentId !== null) return false
    if (todo.reminder === null || todo.remindedAt !== null) return false
    if (todo.dueAt === null) return false
    const dueMs = Date.parse(todo.dueAt)
    if (todo.reminder.snoozeUntil !== null && nowMs < Date.parse(todo.reminder.snoozeUntil)) return false
    if (nowMs < dueMs - (todo.reminder.leadMinutes * 60000)) return false
    return true
  }

  // 提醒扫描与普通写操作共用同一条队列，一轮扫描最多写一次文件
  async function scanReminders() {
    if (scanRunning) return
    scanRunning = true
    try {
      await enqueue(async () => {
        const existing = await readExisting()
        if (existing === null || existing.readOnly) return
        const data = existing.data
        const nowMs = Date.now()
        const hit = data.todos.filter((todo) => reminderDue(todo, nowMs))
        if (hit.length === 0) return
        const remindedAt = new Date(nowMs).toISOString()
        for (const todo of hit) todo.remindedAt = remindedAt
        await writeData(data)
      })
    } finally {
      scanRunning = false
    }
  }

  function runScan() {
    return scanReminders().catch((error) => {
      console.error(`[dsh-4quadrant-todo] 提醒扫描失败: ${messageOf(error)}`)
    })
  }

  async function readReminders() {
    const state = await readStateForRequest()
    const nowMs = Date.now()
    const items = []
    for (const todo of state.data.todos) {
      if (todo.parentId !== null || todo.status !== 'open') continue
      if (todo.reminder === null || todo.remindedAt === null) continue
      items.push({
        id: todo.id,
        title: todo.title,
        quadrant: todo.quadrant,
        workspaceId: todo.workspaceId,
        dueAt: todo.dueAt,
        remindedAt: todo.remindedAt,
        leadMinutes: todo.reminder.leadMinutes,
        minutesUntilDue: todo.dueAt === null ? 0 : Math.round((Date.parse(todo.dueAt) - nowMs) / 60000)
      })
    }
    items.sort((left, right) => {
      const leftTime = left.dueAt === null ? 0 : Date.parse(left.dueAt)
      const rightTime = right.dueAt === null ? 0 : Date.parse(right.dueAt)
      if (leftTime !== rightTime) return leftTime - rightTime
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    })
    return {
      count: state.readOnly ? 0 : items.length,
      at: new Date(nowMs).toISOString(),
      readOnly: state.readOnly,
      items: state.readOnly ? [] : items
    }
  }

  async function snoozeTodo(input) {
    const data = await readDataInWrite()
    const id = requireId(input.id)
    if (input.minutes !== SNOOZE_MINUTES) throw new TodoError(400, `稍后提醒只能是 ${SNOOZE_MINUTES} 分钟`)
    const todo = data.todos.find((item) => item.id === id)
    if (todo === undefined) throw new TodoError(400, `待办不存在: ${id}`)
    const leadMinutes = todo.reminder === null ? data.settings.reminderLeadMinutes : todo.reminder.leadMinutes
    todo.reminder = {
      leadMinutes,
      snoozeUntil: new Date(Date.now() + (SNOOZE_MINUTES * 60000)).toISOString()
    }
    todo.remindedAt = null
    await writeData(data)
    return { upserted: [todo], removedIds: [] }
  }

  async function duplicateRecurrence(input) {
    const data = await readDataInWrite()
    const sourceId = requireId(input.sourceId)
    const targetId = requireId(input.targetId)
    const source = data.todos.find((item) => item.id === sourceId)
    if (source === undefined) throw new TodoError(400, `待办不存在: ${sourceId}`)
    const target = data.todos.find((item) => item.id === targetId)
    if (target === undefined) throw new TodoError(400, `待办不存在: ${targetId}`)
    if (target.parentId !== null) throw new TodoError(400, '目标待办是子待办，不能设置重复')
    if (source.recurrence === null) throw new TodoError(400, '源待办没有重复设置')
    target.recurrence = {
      freq: source.recurrence.freq,
      interval: source.recurrence.interval,
      until: source.recurrence.until
    }
    await writeData(data)
    return { upserted: [target], removedIds: [] }
  }

  async function saveFilter(input) {
    const data = await readDataInWrite()
    const preset = input.preset
    if (!isPlainObject(preset)) throw new TodoError(400, '筛选预设必须是对象')
    const name = typeof preset.name === 'string' ? preset.name.trim() : ''
    if (name === '') throw new TodoError(400, '筛选预设的名称不能为空')
    if (countChars(name) > FILTER_NAME_MAX) throw new TodoError(400, `筛选预设的名称不能超过 ${FILTER_NAME_MAX} 字`)
    const conditions = normalizeConditions(preset.conditions, '筛选条件')
    const now = new Date().toISOString()

    let target
    if (preset.id !== undefined && preset.id !== null) {
      target = data.filters.find((item) => item.id === preset.id)
      if (target === undefined) throw new TodoError(400, `筛选预设不存在: ${String(preset.id)}`)
    }
    const conflict = data.filters.find((item) => item.name === name && item.id !== target?.id)
    if (conflict !== undefined) throw new TodoError(400, `筛选预设的名称已存在: ${name}`)

    if (target === undefined) {
      if (data.filters.length >= FILTERS_MAX) throw new TodoError(400, `筛选预设不能超过 ${FILTERS_MAX} 个`)
      target = { id: newFilterId(), name, conditions, createdAt: now, updatedAt: now }
      data.filters.push(target)
    } else {
      target.name = name
      target.conditions = conditions
      target.updatedAt = now
    }

    await writeData(data)
    return { preset: target, filters: data.filters }
  }

  async function removeFilter(input) {
    const data = await readDataInWrite()
    const id = requireId(input.id)
    const target = data.filters.find((item) => item.id === id)
    if (target === undefined) throw new TodoError(400, `筛选预设不存在: ${id}`)
    data.filters = data.filters.filter((item) => item.id !== id)
    await writeData(data)
    return { filters: data.filters }
  }

  async function exportData() {
    const state = await readStateForRequest()
    return { ...state.data }
  }

  async function importData(input) {
    const payload = input.payload
    if (!isPlainObject(payload)) throw new TodoError(400, '导入内容必须是对象')
    if (typeof input.fileName !== 'string' || input.fileName.trim() === '') {
      throw new TodoError(400, '导入文件名不能为空')
    }
    if (!ACCEPTED_VERSIONS.has(payload.version)) {
      throw new TodoError(400, `导入内容的 version 必须是 1 或 2，实际 ${String(payload.version)}`)
    }
    if (Array.isArray(payload.todos) && payload.todos.length > TODOS_MAX) {
      throw new TodoError(400, `导入内容超过 ${TODOS_MAX} 条上限`)
    }

    const fromVersion = payload.version
    const candidate = fromVersion === 1 ? padToVersion2(payload) : payload
    assertImportCandidate(candidate)

    const state = await readDataForReplace()
    // 先备份再替换，校验失败时主文件保持原样
    const backupFile = state.exists ? await copyBackup(IMPORT_BACKUP_PREFIX) : null
    const next = {
      version: DATA_VERSION,
      todos: candidate.todos,
      collapsed: candidate.collapsed,
      filters: candidate.filters,
      settings: candidate.settings,
      meta: fromVersion === 1
        ? { upgradedAt: new Date().toISOString(), upgradedFrom: 1 }
        : candidate.meta
    }
    await writeData(next)
    return {
      importedCount: next.todos.length,
      fromVersion,
      toVersion: DATA_VERSION,
      backupFile
    }
  }

  async function undoImport(input) {
    const backupFile = requireText(input.backupFile, '备份文件名')
    if (path.basename(backupFile) !== backupFile || !IMPORT_BACKUP_PATTERN.test(backupFile)) {
      throw new TodoError(400, `备份文件名不合法: ${backupFile}`)
    }
    const target = path.join(dataDir, backupFile)
    if (path.dirname(target) !== dataDir) throw new TodoError(400, `备份文件名不合法: ${backupFile}`)

    let text
    try {
      text = await fsp.readFile(target, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') throw new TodoError(400, `备份文件不存在: ${backupFile}`)
      throw new TodoError(500, `备份文件不可读: ${target}，${messageOf(error)}`)
    }

    let raw
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw new TodoError(400, `备份文件无法解析: ${backupFile}，${messageOf(error)}`)
    }
    if (!isPlainObject(raw) || !ACCEPTED_VERSIONS.has(raw.version)) {
      throw new TodoError(400, `备份文件的 version 必须是 1 或 2: ${backupFile}`)
    }
    const data = raw.version === 1 ? padToVersion2(raw) : raw
    assertData(data, importFail)

    // 备份文件按原字节恢复，保持与导入前的文件一致
    await writeText(text)
    return { restoredCount: data.todos.length, restoredAt: new Date().toISOString() }
  }

  async function upgradeData(input) {
    if (input.confirm !== true) throw new TodoError(400, '升级需要显式确认')
    const state = await readDataForReplace()
    if (state.exists && state.readOnly === false) throw new TodoError(400, '数据已经是 2.0 格式')
    if (!state.exists) {
      const empty = emptyData()
      await writeData(empty)
      return { upgradedCount: 0, backupFile: null, fromVersion: null, toVersion: DATA_VERSION }
    }

    const backupFile = await copyBackup(V1_BACKUP_PREFIX)
    const next = {
      ...state.data,
      version: DATA_VERSION,
      meta: { upgradedAt: new Date().toISOString(), upgradedFrom: 1 }
    }
    await writeData(next)
    return { upgradedCount: next.todos.length, backupFile, fromVersion: 1, toVersion: DATA_VERSION }
  }

  // 会话里正在等待用户确认的提问与审批，仅存在于进程内存
  const pendingBySession = new Map()
  let pendingSeq = 0

  function sessionIdOf(event) {
    const agent = event.agent
    if (agent === undefined || agent === null) return null
    if (typeof agent.sessionId === 'string' && agent.sessionId !== '') return agent.sessionId
    return null
  }

  function recordPending(sessionId, entryType, entryId, title, description) {
    if (sessionId === null) return null
    const bucket = pendingBySession.get(sessionId) ?? new Map()
    bucket.set(entryId, {
      entryId,
      entryType,
      title,
      description,
      workspaceId: null,
      quadrant: DEFAULT_QUADRANT,
      createdAt: new Date().toISOString()
    })
    pendingBySession.set(sessionId, bucket)
    return { sessionId, entryId }
  }

  function dropPending(reference) {
    if (reference === null) return
    const bucket = pendingBySession.get(reference.sessionId)
    if (bucket === undefined) return
    bucket.delete(reference.entryId)
    if (bucket.size === 0) pendingBySession.delete(reference.sessionId)
  }

  // 只观察并转交，不认领请求
  ctx.on('user-questions/request', async (request, next) => {
    pendingSeq += 1
    const questions = Array.isArray(request.questions) ? request.questions : []
    const first = questions[0]
    const title = first === undefined
      ? '回答会话提问'
      : String(first.question ?? first.header ?? '回答会话提问').slice(0, TITLE_MAX)
    const description = questions
      .map((item) => String(item.question ?? ''))
      .filter((value) => value !== '')
      .join('\n')
    const entryId = request.wait === undefined ? `question-${pendingSeq}` : String(request.wait.callId)
    const reference = recordPending(sessionIdOf(request), 'question', entryId, title, description)
    try {
      return await next()
    } finally {
      dropPending(reference)
    }
  })

  ctx.on('approval/request', async (request, next) => {
    pendingSeq += 1
    const entryId = request.callId === undefined ? `approval-${pendingSeq}` : String(request.callId)
    const display = request.displayReason
    const reason = display === undefined || display === null
      ? (request.reason ?? '')
      : (display.zh ?? display.en ?? '')
    const reference = recordPending(
      sessionIdOf(request),
      'approval',
      entryId,
      `确认 ${request.toolName} 的执行`,
      reason
    )
    try {
      return await next()
    } finally {
      dropPending(reference)
    }
  })

  function queryOf(rawUrl, key) {
    const index = rawUrl.indexOf('?')
    if (index === -1) return null
    return new URLSearchParams(rawUrl.slice(index + 1)).get(key)
  }

  async function readPending(req) {
    const sessionId = queryOf(req.url, 'sessionId')
    if (sessionId === null || sessionId === '') throw new TodoError(400, 'sessionId 不能为空')
    const bucket = pendingBySession.get(sessionId)
    const items = bucket === undefined ? [] : [...bucket.values()]
    return { sessionId, count: items.length, items }
  }

  const handlers = {
    async snapshot(req, res) {
      const state = await readStateForRequest()
      sendOk(res, {
        version: state.data.version,
        dataVersion: state.readOnly ? 1 : DATA_VERSION,
        readOnly: state.readOnly,
        todos: state.data.todos,
        collapsed: state.data.collapsed,
        filters: state.data.filters,
        settings: state.data.settings,
        meta: state.data.meta
      })
    },

    async reminders(req, res) {
      sendOk(res, await readReminders())
    },

    async pending(req, res) {
      sendOk(res, await readPending(req))
    },

    async exportData(req, res) {
      sendOk(res, await exportData())
    },

    create(req, res) {
      return runWrite(req, res, createTodo)
    },

    update(req, res) {
      return runWrite(req, res, updateTodo)
    },

    complete(req, res) {
      return runWrite(req, res, completeTodos)
    },

    reopen(req, res) {
      return runWrite(req, res, reopenTodos)
    },

    remove(req, res) {
      return runWrite(req, res, removeTodos)
    },

    setQuadrant(req, res) {
      return runWrite(req, res, setQuadrant)
    },

    setCollapsed(req, res) {
      return runWrite(req, res, setCollapsed)
    },

    fromConversation(req, res) {
      return runWrite(req, res, addFromConversation)
    },

    snooze(req, res) {
      return runWrite(req, res, snoozeTodo)
    },

    duplicateRecurrence(req, res) {
      return runWrite(req, res, duplicateRecurrence)
    },

    saveFilter(req, res) {
      return runWrite(req, res, saveFilter)
    },

    removeFilter(req, res) {
      return runWrite(req, res, removeFilter)
    },

    importData(req, res) {
      return runWrite(req, res, importData, IMPORT_BODY_MAX_BYTES)
    },

    undoImport(req, res) {
      return runWrite(req, res, undoImport)
    },

    upgradeData(req, res) {
      return runWrite(req, res, upgradeData)
    }
  }

  function wrap(handler) {
    return async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        const message = messageOf(error)
        console.error(`[dsh-4quadrant-todo] ${req.url}: ${message}`)
        if (res.headersSent) {
          res.end()
          return
        }
        sendFail(res, error instanceof TodoError ? error.status : 500, message)
      }
    }
  }

  const routes = [
    ['/snapshot', handlers.snapshot],
    ['/reminders', handlers.reminders],
    ['/pending', handlers.pending],
    ['/export', handlers.exportData],
    ['/create', handlers.create],
    ['/update', handlers.update],
    ['/complete', handlers.complete],
    ['/reopen', handlers.reopen],
    ['/remove', handlers.remove],
    ['/setQuadrant', handlers.setQuadrant],
    ['/setCollapsed', handlers.setCollapsed],
    ['/fromConversation', handlers.fromConversation],
    ['/snooze', handlers.snooze],
    ['/duplicateRecurrence', handlers.duplicateRecurrence],
    ['/filterSave', handlers.saveFilter],
    ['/filterRemove', handlers.removeFilter],
    ['/import', handlers.importData],
    ['/import/undo', handlers.undoImport],
    ['/upgrade', handlers.upgradeData]
  ]

  for (const [suffix, handler] of routes) {
    const routePath = `${ROUTE}${suffix}`
    ctx.effect(
      () => webServer.register({ kind: 'exact', path: routePath, handler: wrap(handler) }),
      `dsh-4quadrant-todo: ${routePath}`
    )
  }

  ctx.effect(() => {
    const stopInterval = timer.interval(runScan, REMINDER_SCAN_INTERVAL_MS)
    const stopKickoff = timer.timeout(runScan, REMINDER_FIRST_SCAN_DELAY_MS)
    return () => {
      stopInterval?.()
      stopKickoff?.()
    }
  }, 'dsh-4quadrant-todo: 提醒扫描')

  console.log(`[dsh-4quadrant-todo] 数据文件 ${dataFile}，路由 ${routes.length} 条`)
}
