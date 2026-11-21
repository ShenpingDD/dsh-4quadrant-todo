// 飞书同步（管理面）：lark-cli 探测、设备码登录、任务清单读取、sync-config.json 读写、触发同步脚本
// 同步算法本身在 scripts/feishu-sync.mjs 里，这里只做界面需要的查询与写入，避免两套逻辑
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const QUADRANT_IDS = [
  'urgent-important',
  'urgent-not-important',
  'not-urgent-important',
  'not-urgent-not-important'
]

// 同步用到的最小权限集，缺任意一项界面上都要提示
const TASK_SCOPES = ['task:task:read', 'task:task:write', 'task:tasklist:read', 'task:tasklist:write']

const DEFAULT_LIST_NAMES = {
  'urgent-important': '🔥 紧急且重要',
  'urgent-not-important': '⛰️ 紧急不重要',
  'not-urgent-important': '⛳ 重要不紧急',
  'not-urgent-not-important': '🛶 不重要不紧急'
}

const CONFIG_VERSION = 1
const LOG_TAIL_LINES = 6
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'feishu-sync.mjs')

export class SyncError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'SyncError'
    this.status = status
  }
}

function cliName() {
  const override = process.env.LARK_CLI
  return typeof override === 'string' && override.trim() !== '' ? override.trim() : 'lark-cli'
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

// lark-cli 会在 JSON 前后打印提示行（例如 refresh_token 过期），取第一个完整的 JSON 对象
function parseJsonText(text) {
  const raw = textOf(text)
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

function firstLine(text, limit = 400) {
  const line = textOf(text).trim().split('\n').find((item) => item.trim() !== '') ?? ''
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

function pickArray(payload) {
  if (Array.isArray(payload)) return payload
  if (payload === null || typeof payload !== 'object') return []
  if (Array.isArray(payload.items)) return payload.items
  if (Array.isArray(payload.data)) return payload.data
  if (payload.data !== null && typeof payload.data === 'object' && Array.isArray(payload.data.items)) {
    return payload.data.items
  }
  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) return value
    if (value !== null && typeof value === 'object' && Array.isArray(value.items)) return value.items
  }
  return []
}

function normalizeTasklist(item) {
  if (item === null || typeof item !== 'object') return null
  const guid = textOf(item.guid ?? item.tasklist_guid ?? item.id)
  const name = textOf(item.name ?? item.summary ?? item.title)
  if (guid === '') return null
  const total = Number(item.task_count ?? item.taskCount)
  return { guid, name: name === '' ? guid : name, taskCount: Number.isFinite(total) ? total : null }
}

export function createSyncService(options) {
  const dataDir = options.dataDir
  const configFile = path.join(dataDir, 'sync-config.json')
  const stateFile = path.join(dataDir, 'sync-state.json')
  const logFile = path.join(dataDir, 'sync.log')
  const waiters = new Map()
  let lastRunResult = null

  function run(args, timeout = 15000) {
    return new Promise((resolve) => {
      execFile(cliName(), args, { timeout, maxBuffer: 8 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
        resolve({ error, stdout: textOf(stdout), stderr: textOf(stderr) })
      })
    })
  }

  async function cliInfo() {
    const result = await run(['--version'], 8000)
    if (result.error !== null && result.error !== undefined) {
      const code = result.error.code
      if (code === 'ENOENT') {
        return { installed: false, name: cliName(), version: null, path: null, error: '未找到 lark-cli 命令' }
      }
      return { installed: true, name: cliName(), version: null, path: null, error: firstLine(result.error.message) }
    }
    const match = /(\d+\.\d+\.\d+[\w.-]*)/.exec(result.stdout)
    const located = await which()
    return { installed: true, name: cliName(), version: match === null ? null : match[1], path: located, error: null }
  }

  async function which() {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    const result = await new Promise((resolve) => {
      execFile(finder, [cliName()], { timeout: 5000 }, (error, stdout) => {
        resolve({ error, stdout: textOf(stdout) })
      })
    })
    if (result.error !== null && result.error !== undefined) return null
    return firstLine(result.stdout, 300) || null
  }

  function normalizeAuth(payload) {
    const identities = payload?.identities ?? {}
    const bot = identities.bot ?? {}
    const user = identities.user ?? {}
    const scopeText = textOf(user.scope)
    const granted = new Set(scopeText.split(/\s+/).filter((item) => item !== ''))
    const missingScopes = TASK_SCOPES.filter((scope) => granted.has(scope) === false)
    const userStatus = textOf(user.status) || 'unknown'
    return {
      identity: textOf(payload?.identity) || 'unknown',
      bot: { status: textOf(bot.status) || 'unknown', ready: bot.available === true },
      user: {
        status: userStatus,
        ready: userStatus === 'ready' && missingScopes.length === 0,
        userName: textOf(user.userName) || null,
        openId: textOf(user.openId) || null,
        expiresAt: textOf(user.expiresAt) || null,
        refreshExpiresAt: textOf(user.refreshExpiresAt) || null,
        missingScopes,
        scopeCount: granted.size,
        message: textOf(user.message) || null
      }
    }
  }

  async function authStatus() {
    const result = await run(['auth', 'status'], 15000)
    const payload = parseJsonText(result.stdout)
    if (payload === null) {
      return {
        ok: false,
        error: firstLine(result.stderr) || firstLine(result.stdout) || '无法读取 lark-cli 登录状态',
        auth: null
      }
    }
    return { ok: true, error: null, auth: normalizeAuth(payload) }
  }

  async function readConfig() {
    let text
    try {
      text = await readFile(configFile, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { exists: false, error: null, mode: 'tasklists', lists: {}, intervalMinutes: null }
      }
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return { exists: true, error: 'sync-config.json 不是合法的 JSON', mode: 'tasklists', lists: {}, intervalMinutes: null }
    }
    const lists = {}
    for (const id of QUADRANT_IDS) {
      const value = parsed?.lists?.[id]
      if (typeof value === 'string' && value.trim() !== '') lists[id] = value.trim()
    }
    const interval = Number(parsed?.intervalMinutes)
    return {
      exists: true,
      error: null,
      version: Number(parsed?.version) || CONFIG_VERSION,
      mode: parsed?.mode === 'tasklists' ? 'tasklists' : 'tasklists',
      lists,
      intervalMinutes: Number.isFinite(interval) && interval > 0 ? interval : null
    }
  }

  async function writeConfig(next) {
    await mkdir(dataDir, { recursive: true })
    await writeFile(configFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  }

  async function readLastRun() {
    let state = null
    try {
      state = JSON.parse(await readFile(stateFile, 'utf8'))
    } catch {
      state = null
    }
    let logTail = []
    try {
      const text = await readFile(logFile, 'utf8')
      logTail = text.trimEnd().split('\n').slice(-LOG_TAIL_LINES)
    } catch {
      logTail = []
    }
    const mapped = state === null || typeof state.items !== 'object' || state.items === null
      ? 0
      : Object.keys(state.items).length
    return {
      lastRunAt: textOf(state?.lastRunAt) || null,
      mappedItems: mapped,
      logTail,
      lastRunResult
    }
  }

  async function status() {
    const cli = await cliInfo()
    const auth = cli.installed ? await authStatus() : { ok: false, error: '未找到 lark-cli', auth: null }
    return {
      cli,
      auth: auth.auth,
      authError: auth.error,
      config: await readConfig(),
      quadrantIds: QUADRANT_IDS,
      defaultNames: DEFAULT_LIST_NAMES,
      dataDir,
      lastRun: await readLastRun()
    }
  }

  // 设备码登录：先拿授权链接，再让 lark-cli 在后台用 device_code 换取凭证
  async function loginStart() {
    const info = await cliInfo()
    if (info.installed === false) throw new SyncError(409, '未安装 lark-cli，先执行：npm install -g @larksuite/lark-cli')
    const result = await run(['auth', 'login', '--no-wait', '--domain', 'task', '--json'], 30000)
    const payload = parseJsonText(result.stdout)
    if (payload === null || typeof payload.device_code !== 'string') {
      throw new SyncError(502, firstLine(result.stderr) || firstLine(result.stdout) || 'lark-cli 没有返回设备码')
    }
    const deviceCode = payload.device_code
    const url = textOf(payload.verification_url)
    const existing = waiters.get(deviceCode)
    if (existing === undefined) {
      const child = spawn(cliName(), ['auth', 'login', '--device-code', deviceCode, '--json'], {
        stdio: 'ignore',
        env: process.env
      })
      const waiter = { state: 'pending', error: null, startedAt: new Date().toISOString() }
      waiters.set(deviceCode, waiter)
      child.on('exit', (code) => {
        waiter.state = code === 0 ? 'done' : 'failed'
        if (code !== 0) waiter.error = `lark-cli 退出码 ${code}`
      })
      child.on('error', (error) => {
        waiter.state = 'failed'
        waiter.error = error.message
      })
      child.unref()
    }
    return {
      deviceCode,
      verificationUrl: url,
      expiresIn: Number(payload.expires_in) || 600,
      qrText: await qrAscii(url)
    }
  }

  async function qrAscii(url) {
    if (url === '') return null
    const result = await run(['auth', 'qrcode', url, '--ascii'], 15000)
    if (result.error !== null && result.error !== undefined) return null
    return result.stdout.trimEnd() || null
  }

  async function loginPoll(deviceCode) {
    const waiter = waiters.get(typeof deviceCode === 'string' ? deviceCode : '')
    const current = await authStatus()
    const ready = current.ok === true && current.auth.user.ready === true
    if (ready === true && waiter !== undefined) waiters.delete(deviceCode)
    return {
      ready,
      waiterState: waiter === undefined ? 'unknown' : waiter.state,
      waiterError: waiter === undefined ? null : waiter.error,
      auth: current.auth,
      authError: current.error
    }
  }

  async function tasklists() {
    const current = await authStatus()
    if (current.ok === false) throw new SyncError(409, current.error)
    if (current.auth.user.ready === false) {
      throw new SyncError(409, '飞书用户身份未就绪，先在「飞书同步」里点登录')
    }
    const result = await run(['task', 'tasklists', 'list', '--as', 'user', '--page-all', '--json'], 40000)
    const payload = parseJsonText(result.stdout)
    if (payload === null) throw new SyncError(502, firstLine(result.stderr) || 'lark-cli 返回内容不是 JSON')
    if (payload.ok === false) {
      const message = textOf(payload?.error?.message) || firstLine(result.stderr) || '读取飞书任务清单失败'
      throw new SyncError(502, message)
    }
    const items = pickArray(payload).map(normalizeTasklist).filter((item) => item !== null)
    return { items, count: items.length }
  }

  async function createQuadrants(requested) {
    const names = { ...DEFAULT_LIST_NAMES }
    if (requested !== null && typeof requested === 'object') {
      for (const id of QUADRANT_IDS) {
        const value = requested[id]
        if (typeof value === 'string' && value.trim() !== '') names[id] = value.trim()
      }
    }
    const current = await readConfig()
    const lists = { ...current.lists }
    const created = []
    for (const id of QUADRANT_IDS) {
      if (typeof lists[id] === 'string' && lists[id] !== '') continue
      const result = await run(['task', '+tasklist-create', '--as', 'user', '--name', names[id], '--json'], 30000)
      const payload = parseJsonText(result.stdout)
      if (payload === null || payload.ok === false) {
        const message = textOf(payload?.error?.message) || firstLine(result.stderr) || '创建任务清单失败'
        throw new SyncError(502, `${names[id]}: ${message}`)
      }
      const item = normalizeTasklist(payload?.data ?? payload)
      if (item === null) throw new SyncError(502, `${names[id]}: lark-cli 没有返回清单 guid`)
      lists[id] = item.guid
      created.push({ quadrant: id, name: names[id], guid: item.guid })
    }
    await writeConfig({ version: CONFIG_VERSION, mode: 'tasklists', lists, intervalMinutes: current.intervalMinutes })
    return { created, config: await readConfig() }
  }

  async function saveConfig(body) {
    const current = await readConfig()
    const lists = { ...current.lists }
    const incoming = body?.lists
    if (incoming !== null && incoming !== undefined) {
      if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
        throw new SyncError(400, 'lists 必须是对象')
      }
      for (const [id, value] of Object.entries(incoming)) {
        if (QUADRANT_IDS.includes(id) === false) throw new SyncError(400, `未知象限：${id}`)
        if (value === null || value === '') {
          delete lists[id]
          continue
        }
        if (typeof value !== 'string') throw new SyncError(400, `${id} 的清单 guid 必须是字符串`)
        lists[id] = value.trim()
      }
    }
    let intervalMinutes = current.intervalMinutes
    if (body?.intervalMinutes !== undefined) {
      if (body.intervalMinutes === null) intervalMinutes = null
      else {
        const value = Number(body.intervalMinutes)
        if (Number.isFinite(value) === false || value <= 0 || value > 1440) {
          throw new SyncError(400, 'intervalMinutes 必须在 1 到 1440 之间')
        }
        intervalMinutes = Math.round(value)
      }
    }
    await writeConfig({ version: CONFIG_VERSION, mode: 'tasklists', lists, intervalMinutes })
    const saved = await readConfig()
    const missing = QUADRANT_IDS.filter((id) => typeof saved.lists[id] !== 'string')
    return { config: saved, missing }
  }

  async function runSync(request, apiBase) {
    const dryRun = request?.dryRun === true
    const args = [SCRIPT, '--api', apiBase, '--data-dir', dataDir]
    if (dryRun) args.push('--dry-run')
    const result = await new Promise((resolve) => {
      execFile(process.execPath, args, { timeout: 180000, maxBuffer: 8 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
        resolve({ error, stdout: textOf(stdout), stderr: textOf(stderr) })
      })
    })
    const lines = result.stdout.trim().split('\n').filter((line) => line.trim() !== '')
    const summary = lines.at(-1) ?? ''
    const stderrLine = firstLine(result.stderr)
    lastRunResult = {
      at: new Date().toISOString(),
      dryRun,
      summary,
      error: result.error === null || result.error === undefined ? null : stderrLine || firstLine(result.error.message)
    }
    if (lastRunResult.error !== null) {
      throw new SyncError(502, lastRunResult.error)
    }
    return { summary, dryRun, stderr: firstLine(result.stderr) }
  }

  return { status, loginStart, loginPoll, tasklists, createQuadrants, saveConfig, runSync }
}
