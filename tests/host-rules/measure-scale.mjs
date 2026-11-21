// Host 半规模测量：按 PRD 12.4 的上限（未完成 1000 条、已完成 1 万条）造真实数据文件，
// 测量读取与整文件写入的耗时。数据目录为本目录下的 .run，不触碰 %DSH_HOME%。

import { createServer } from 'node:http'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../../lib/index.js'

const PREFIX = '/plugins/dsh-4quadrant-todo'
const here = path.dirname(fileURLToPath(import.meta.url))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const dataDir = path.join(here, '.run', `scale-${stamp}`)
const dataFile = path.join(dataDir, 'todos.json')

await fsp.mkdir(dataDir, { recursive: true })

const OPEN_COUNT = Number(process.env.OPEN_COUNT ?? 1000)
const DONE_COUNT = Number(process.env.DONE_COUNT ?? 10000)
const QUADRANTS = ['urgent-important', 'urgent-not-important', 'not-urgent-important', 'not-urgent-not-important']

function buildTodo(index, status) {
  const created = new Date(Date.UTC(2026, 0, 1) + index * 60000).toISOString()
  return {
    id: `t_scale_${status}_${index}`,
    title: `规模样例 ${status} ${index} 标题文字用于接近真实长度`,
    description: '描述文字'.repeat(10),
    quadrant: QUADRANTS[index % 4],
    dueAt: index % 3 === 0 ? null : new Date(Date.UTC(2026, 1, 1) + index * 60000).toISOString(),
    parentId: null,
    status,
    createdAt: created,
    completedAt: status === 'done' ? new Date(Date.UTC(2026, 2, 1) + index * 60000).toISOString() : null,
    workspaceId: index % 2 === 0 ? null : 'ws-scale',
    source: { kind: 'manual' },
    sourceKey: null
  }
}

const todos = []
for (let index = 0; index < OPEN_COUNT; index += 1) todos.push(buildTodo(index, 'open'))
for (let index = 0; index < DONE_COUNT; index += 1) todos.push(buildTodo(index, 'done'))

const collapsed = {
  all: {
    'urgent-important': false,
    'urgent-not-important': false,
    'not-urgent-important': false,
    'not-urgent-not-important': false
  }
}

await fsp.writeFile(dataFile, `${JSON.stringify({ version: 1, todos, collapsed }, null, 2)}\n`, 'utf8')
const sizeBytes = (await fsp.stat(dataFile)).size

const handlers = new Map()
const webServer = {
  register(route) {
    handlers.set(route.path, route.handler)
    return () => {
      handlers.delete(route.path)
    }
  }
}
const ctx = {
  get(serviceName) {
    return serviceName === 'webServer' ? webServer : undefined
  },
  effect(fn) {
    return fn()
  }
}

apply(ctx, { dataDir })

const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  const handler = handlers.get(pathname)
  if (handler === undefined) {
    res.writeHead(404)
    res.end('{}')
    return
  }
  Promise.resolve(handler(req, res)).catch(() => {
    res.writeHead(500)
    res.end('{}')
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}${PREFIX}`

async function timed(label, run) {
  const durations = []
  let status = 0
  let bytes = 0
  for (let round = 0; round < 5; round += 1) {
    const startedAt = process.hrtime.bigint()
    const response = await run()
    const text = await response.text()
    const endedAt = process.hrtime.bigint()
    status = response.status
    bytes = Buffer.byteLength(text)
    durations.push(Number(endedAt - startedAt) / 1e6)
  }
  durations.sort((left, right) => left - right)
  console.log(`${label}: status=${status} 响应字节=${bytes} 中位耗时=${durations[2].toFixed(1)}ms 最慢=${durations[4].toFixed(1)}ms`)
}

console.log(`数据文件：${dataFile}`)
console.log(`文件大小：${(sizeBytes / 1024 / 1024).toFixed(2)} MiB，待办 ${OPEN_COUNT} 未完成 + ${DONE_COUNT} 已完成`)

await timed('GET /snapshot', () => fetch(`${base}/snapshot`))

await timed('POST /create', () => fetch(`${base}/create`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-dsh-todo': '1' },
  body: JSON.stringify({ title: '规模测量新建样例', quadrant: 'urgent-important' })
}))

await timed('POST /update', () => fetch(`${base}/update`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-dsh-todo': '1' },
  body: JSON.stringify({ id: 't_scale_open_0', dueAt: '2026-12-01T09:00+08:00' })
}))

const afterSize = (await fsp.stat(dataFile)).size
console.log(`写入五次后文件大小：${(afterSize / 1024 / 1024).toFixed(2)} MiB`)

await new Promise((resolve) => server.close(resolve))
