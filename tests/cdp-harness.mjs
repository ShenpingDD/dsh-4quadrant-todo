import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
export const PORT = 9334
export const ORIGIN = 'http://127.0.0.1:3080'
export const API = `${ORIGIN}/plugins/dsh-4quadrant-todo`
export const SERVER_LOG = 'D:\\Workspace\\Deepseek Harness Workspace\\.dsh-logs\\web-3080.stdout.log'

const here = path.dirname(fileURLToPath(import.meta.url))
// 浏览器配置目录放在 .run 下，与运行期产物同处
export const profile = path.join(here, '.run', 'browser-profile')

export async function waitForDebugger() {
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

export class Cdp {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
    this.consoleErrors = []
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
      this.consoleErrors.push(`exception: ${detail.text} ${detail.exception?.description ?? ''}`)
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const text = message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' ')
      this.consoleErrors.push(`console.error: ${text}`)
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

export async function waitFor(cdp, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await cdp.evaluate(expression)
    if (value) return value
    await delay(200)
  }
  throw new Error(`等待超时: ${label}`)
}

export async function apiPost(route, body) {
  const response = await fetch(`${API}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-todo': '1' },
    body: JSON.stringify(body)
  })
  const payload = await response.json()
  if (payload.ok !== true) throw new Error(payload.error)
  return payload.value
}

export async function apiSnapshot() {
  const response = await fetch(`${API}/snapshot`)
  const payload = await response.json()
  if (payload.ok !== true) throw new Error(payload.error)
  return payload.value
}

export async function apiGet(route) {
  const response = await fetch(`${API}${route}`)
  const payload = await response.json()
  if (payload.ok !== true) throw new Error(payload.error)
  return payload.value
}

// 插件数据目录，与 Host 的默认取值一致
export const dataDir = path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh'), 'four-quadrant-todo')

export async function readServerUrl() {
  const text = await readFile(SERVER_LOG, 'utf8')
  const matches = [...text.matchAll(/dsh web: (\S+)/g)]
  if (matches.length === 0) throw new Error('服务器日志里没有访问地址')
  return matches[matches.length - 1][1]
}

export async function launchAndConnect(appUrl) {
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

  await waitForDebugger()
  let page = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const pages = await listPages()
    page = pages.find((item) => item.type === 'page' && item.url.startsWith(ORIGIN))
    if (page !== undefined) break
    await delay(250)
  }
  if (page === null || page === undefined) throw new Error('没有找到应用页面')

  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  return { browser, cdp }
}

export function clickByLabel(cdp, label) {
  return cdp.evaluate(`
    (() => {
      const nodes = [...document.querySelectorAll('button,[role="button"]')]
      const target = nodes.find((node) => node.getAttribute('aria-label') === ${JSON.stringify(label)})
      if (target === undefined) return false
      target.click()
      return true
    })()
  `)
}

export function clickByText(cdp, scope, text) {
  return cdp.evaluate(`
    (() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})]
      const target = nodes.find((node) => (node.textContent || '').trim() === ${JSON.stringify(text)})
      if (target === undefined) return false
      target.click()
      return true
    })()
  `)
}
