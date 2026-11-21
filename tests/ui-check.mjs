import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { readFile, readdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { saveBackup } from './data-guard.mjs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9333
const ORIGIN = 'http://127.0.0.1:3080'
const API = `${ORIGIN}/plugins/dsh-4quadrant-todo`
const SERVER_LOG = 'D:\\Workspace\\Deepseek Harness Workspace\\.dsh-logs\\web-3080.stdout.log'
const here = path.dirname(fileURLToPath(import.meta.url))
const profile = path.join(here, '.run', 'browser-profile-basic')
const dataDirPath = path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh'), 'four-quadrant-todo')

const failures = []
const consoleErrors = []
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) console.log(`PASS ${label}`)
  else {
    console.log(`FAIL ${label} -> ${detail}`)
    failures.push(label)
  }
}

async function waitForDebugger() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (response.ok) return await response.json()
    } catch {}
    await delay(250)
  }
  throw new Error('浏览器调试端口未就绪')
}

async function listPages() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return await response.json()
}

class Cdp {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
  }

  async connect() {
    this.socket = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
    })
    this.socket.addEventListener('message', (event) => this.onMessage(event.data))
  }

  onMessage(raw) {
    const message = JSON.parse(raw)
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params.exceptionDetails
      consoleErrors.push(`exception: ${detail.text} ${detail.exception?.description ?? ''}`)
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const text = message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' ')
      consoleErrors.push(`console.error: ${text}`)
    }
  }

  send(method, params = {}) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(`页面求值抛出: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`)
    }
    return result.result.value
  }

  close() {
    this.socket.close()
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await cdp.evaluate(expression)
    if (value) return value
    await delay(200)
  }
  throw new Error(`等待超时: ${label}`)
}

async function apiPost(route, body) {
  const response = await fetch(`${API}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-todo': '1' },
    body: JSON.stringify(body)
  })
  const payload = await response.json()
  if (payload.ok !== true) throw new Error(payload.error)
  return payload.value
}

async function apiSnapshot() {
  const response = await fetch(`${API}/snapshot`)
  const payload = await response.json()
  if (payload.ok !== true) throw new Error(payload.error)
  return payload.value
}

async function readServerUrl() {
  const text = await readFile(SERVER_LOG, 'utf8')
  const matches = [...text.matchAll(/dsh web: (\S+)/g)]
  if (matches.length === 0) throw new Error('服务器日志里没有访问地址')
  return matches[matches.length - 1][1]
}

const appUrl = await readServerUrl()

async function apiExport() {
  const response = await fetch(`${API}/export`)
  const payload = await response.json()
  if (payload.ok !== true) throw new Error(payload.error)
  return payload.value
}

// 运行前的完整数据，收尾按它恢复
const originalData = await apiExport()
await saveBackup(originalData, 'ui-check')
const startedAt = Date.now()

const leftovers = await apiSnapshot()
for (const item of leftovers.todos) {
  if (item.parentId === null) await apiPost('/remove', { ids: [item.id] })
}
for (const quadrant of ['urgent-important', 'urgent-not-important', 'not-urgent-important', 'not-urgent-not-important']) {
  await apiPost('/setCollapsed', { scopeKey: 'all', quadrant, collapsed: false })
}

const browser = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-features=Translate',
  appUrl
], { stdio: 'ignore' })

let cdp = null
try {
  await waitForDebugger()
  let page = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const pages = await listPages()
    page = pages.find((item) => item.type === 'page' && item.url.startsWith(ORIGIN))
    if (page !== undefined) break
    await delay(250)
  }
  if (page === null || page === undefined) throw new Error('没有找到应用页面')

  cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  await waitFor(cdp, "document.querySelectorAll('button').length > 0", '侧栏按钮出现', 40000)

  const labels = await cdp.evaluate(`
    JSON.stringify([...document.querySelectorAll('button,[role="button"]')].map((node) => ({
      label: node.getAttribute('aria-label'),
      title: node.getAttribute('title'),
      text: (node.textContent || '').trim().slice(0, 40)
    })))
  `)
  console.log('侧栏按钮:', labels)

  const clicked = await cdp.evaluate(`
    (() => {
      const nodes = [...document.querySelectorAll('button,[role="button"],a')]
      const target = nodes.find((node) => {
        const values = [node.getAttribute('aria-label'), node.getAttribute('title'), (node.textContent || '').trim()]
        return values.some((value) => value !== null && value.includes('待办中心'))
      })
      if (target === undefined) return false
      target.click()
      return true
    })()
  `)
  check('侧栏存在待办中心入口并可点击', clicked === true, '没有找到入口')

  await waitFor(cdp, "document.querySelector('.tc-page') !== null", '待办中心页面出现', 20000)
  const pageText = await cdp.evaluate("document.querySelector('.tc-page').innerText")
  check('页面出现四个象限标题', ['紧急且重要', '重要不紧急', '紧急不重要', '不重要不紧急'].every((name) => pageText.includes(name)), '象限标题缺失')
  check('页面出现四象限与已完成两个页签', pageText.includes('四象限') && pageText.includes('已完成'), '页签缺失')
  check('页面出现工作区切换器', pageText.includes('全部工作区'), '切换器缺失')

  const created = await apiPost('/create', {
    title: '界面验证任务',
    description: '用于验证卡片渲染',
    quadrant: 'urgent-important',
    dueAt: '2099-12-31T23:59+08:00'
  })
  const parentId = created.focusId
  await apiPost('/create', { title: '界面验证子任务', parentId })

  await cdp.send('Page.reload')
  await delay(1500)
  await waitFor(cdp, "document.querySelectorAll('button').length > 0", '重新加载后的按钮', 40000)
  await cdp.evaluate(`
    (() => {
      const nodes = [...document.querySelectorAll('button,[role="button"],a')]
      const target = nodes.find((node) => {
        const values = [node.getAttribute('aria-label'), node.getAttribute('title'), (node.textContent || '').trim()]
        return values.some((value) => value !== null && value.includes('待办中心'))
      })
      if (target !== undefined) target.click()
    })()
  `)
  await waitFor(cdp, "document.querySelector('.tc-page') !== null", '重新加载后再次打开面板', 20000)
  await waitFor(cdp, "document.body.innerText.includes('界面验证任务')", '卡片渲染出待办标题', 15000)
  const cardState = JSON.parse(await cdp.evaluate(`
    (() => {
      const card = [...document.querySelectorAll('.tc-card')]
        .find((node) => (node.querySelector('.tc-card-title')?.textContent ?? '').trim() === '界面验证任务')
      if (card === undefined) return JSON.stringify({ found: false })
      return JSON.stringify({
        found: true,
        time: (card.querySelector('.tc-card-time')?.textContent ?? '').trim(),
        progress: (card.querySelector('.tc-card-mark-button')?.textContent ?? '').trim(),
        title: (card.querySelector('.tc-card-title')?.textContent ?? '').trim(),
        height: Math.round(card.getBoundingClientRect().height)
      })
    })()
  `))
  check('卡片显示子待办进度', cardState.progress === '0/1', `进度 ${cardState.progress}`)
  check('卡片右侧显示截止倒计时', cardState.time === '2099-12-31', `倒计时 ${cardState.time}`)

  await cdp.evaluate(`
    (() => {
      const card = [...document.querySelectorAll('.tc-card')]
        .find((node) => (node.querySelector('.tc-card-title')?.textContent ?? '').trim() === '界面验证任务')
      card.querySelector('.tc-card-title-button').click()
    })()
  `)
  await waitFor(cdp, "document.querySelector('.tc-drawer') !== null", '打开编辑抽屉', 8000)
  const drawerState = JSON.parse(await cdp.evaluate(`
    (() => {
      const drawer = document.querySelector('.tc-drawer')
      const description = drawer.querySelector('textarea[aria-label="描述"]')
      const childTitles = [...drawer.querySelectorAll('.tc-child .tc-child-title')].map((node) => (node.textContent ?? '').trim())
      return JSON.stringify({
        description: description === null ? '' : description.value,
        childTitles,
        mode: drawer.getAttribute('data-tc-drawer')
      })
    })()
  `))
  check('抽屉里显示描述', drawerState.description.includes('用于验证卡片渲染'), `描述 ${drawerState.description}`)
  check('抽屉里显示子待办标题', drawerState.childTitles.includes('界面验证子任务'), `子待办 ${drawerState.childTitles.join('、')}`)
  check('从卡片标题打开的是编辑抽屉', drawerState.mode === 'edit', `模式 ${drawerState.mode}`)
  await cdp.evaluate(`
    (() => {
      const cancel = [...document.querySelectorAll('.tc-drawer-foot button')]
        .find((node) => (node.textContent ?? '').trim() === '取消')
      cancel.click()
    })()
  `)
  await delay(300)

  await cdp.evaluate("document.querySelector('.tc-card .tc-check-slot .tc-check').click()")
  const dialogText = await waitFor(cdp, "document.querySelector('.tc-modal')?.innerText ?? ''", '合并完成确认框', 8000)
  check('父任务存在未完成子待办时弹出确认', dialogText.includes('未完成的子待办'), `确认框文本 ${dialogText}`)
  await cdp.evaluate(`
    (() => {
      const button = [...document.querySelectorAll('.tc-modal button')].find((node) => (node.textContent || '').trim() === '一并完成')
      if (button !== undefined) button.click()
    })()
  `)
  await delay(300)
  let completedItem = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const snapshot = await apiSnapshot()
    completedItem = snapshot.todos.find((item) => item.id === parentId)
    if (completedItem !== undefined && completedItem.status === 'done') break
    await delay(250)
  }
  const afterComplete = await apiSnapshot()
  const parent = afterComplete.todos.find((item) => item.id === parentId)
  check('点击勾选后父任务进入已完成', parent !== undefined && parent.status === 'done', `状态 ${parent?.status}`)
  const child = afterComplete.todos.find((item) => item.parentId === parentId)
  check('父任务完成时子待办一并完成', child !== undefined && child.status === 'done', `子任务状态 ${child?.status}`)

  await cdp.evaluate(`
    (() => {
      const tab = [...document.querySelectorAll('[role="tab"]')]
        .find((node) => (node.textContent || '').trim() === '已完成')
      if (tab !== undefined) tab.click()
    })()
  `)
  await waitFor(cdp, `[...document.querySelectorAll('[role="tab"]')].some((node) => (node.textContent || '').trim() === '已完成' && node.getAttribute('aria-selected') === 'true')`, '切换到已完成页', 8000)
  const completedState = await cdp.evaluate(`
    (() => {
      const panel = document.querySelector('.tc-tabpanel')
      const selected = [...document.querySelectorAll('[role="tab"]')]
        .filter((node) => node.getAttribute('aria-selected') === 'true')
        .map((node) => (node.textContent || '').trim())
      return JSON.stringify({
        selected,
        pattern: panel === null ? null : panel.getAttribute('data-tc-tab'),
        panel: panel === null ? null : panel.innerText.slice(0, 160),
        rows: document.querySelectorAll('.tc-list-row').length
      })
    })()
  `)
  console.log(`观察: 已完成页状态 ${completedState}`)
  await waitFor(cdp, "document.querySelectorAll('.tc-list-row').length > 0", '已完成清单出现数据行', 8000)
  const completedText = await cdp.evaluate("document.querySelector('.tc-tabpanel').innerText")
  check('已完成清单显示标题与完成时间', completedText.includes('界面验证任务') && completedText.includes('完成'), `已完成清单 ${completedText}`)

  const steps = await cdp.evaluate("document.querySelectorAll('.tc-list-row').length")
  check('已完成清单渲染出数据行', steps >= 1, `行数 ${steps}`)

  const relevantErrors = consoleErrors.filter((text) => !text.includes('favicon') && !text.includes('Download the React DevTools'))
  check('页面没有脚本错误', relevantErrors.length === 0, relevantErrors.join(' | '))

  await cdp.evaluate(`
    (() => {
      const button = [...document.querySelectorAll('.tc-header button')].find((node) => (node.textContent || '').trim() === '关闭')
      if (button !== undefined) button.click()
    })()
  `)
  await delay(800)
  const closed = await cdp.evaluate("document.querySelector('.tc-page') === null")
  check('点击关闭返回会话视图', closed === true, '面板仍然存在')

  await apiPost('/remove', { ids: [parentId] })
  const cleaned = await apiSnapshot()
  check('清场后待办数量为 0', cleaned.todos.length === 0, `剩余 ${cleaned.todos.length}`)
} finally {
  if (consoleErrors.length > 0) console.log('页面错误明细:', JSON.stringify(consoleErrors, null, 2))
  if (cdp !== null) {
    try {
      const text = await cdp.evaluate("document.body.innerText.slice(0, 800)")
      console.log('退出时页面文本:', text)
    } catch {}
    cdp.close()
  }
  browser.kill()
  await delay(500)

  // 恢复运行前的数据，并删除本套件产生的导入备份
  await apiPost('/import', { payload: originalData, fileName: 'ui-check-restore.json' })
  const restored = await apiSnapshot()
  const same = (value) => JSON.stringify({
    titles: value.todos.map((todo) => `${todo.title}|${todo.status}|${todo.quadrant}|${todo.dueAt}`).sort(),
    collapsed: value.collapsed,
    filters: value.filters.map((preset) => preset.name).sort()
  })
  check('结束时数据回到运行前的内容', same(restored) === same(originalData), `现状 ${same(restored)} 运行前 ${same(originalData)}`)
  let removedBackups = 0
  for (const name of await readdir(dataDirPath)) {
    if (name.startsWith('todos.before-import-') === false) continue
    const info = await stat(path.join(dataDirPath, name))
    if (info.mtimeMs < startedAt) continue
    await unlink(path.join(dataDirPath, name))
    removedBackups += 1
  }
  console.log(`清理导入备份 ${removedBackups} 个`)
}

console.log('----')
console.log(`共 ${checks} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  for (const name of failures) console.log(`未通过: ${name}`)
  process.exit(1)
}
process.exit(0)
