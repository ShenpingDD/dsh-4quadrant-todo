#!/usr/bin/env node
// 测试用的 lark-cli 替身：只实现插件用到的子命令，行为由 STUB_LARK_USER 控制
// STUB_LARK_USER=missing（默认）时用户身份未就绪；=ready 时返回可用的清单数据
import fs from 'node:fs'

const args = process.argv.slice(2)
const userReady = (process.env.STUB_LARK_USER ?? 'missing') === 'ready'
// 记录每次调用，测试据此断言"先加目标清单、再移出原清单"
if (process.env.STUB_LARK_LOG !== undefined) {
  fs.appendFileSync(process.env.STUB_LARK_LOG, `${JSON.stringify(args)}\n`)
}
const scenario = JSON.parse(process.env.STUB_LARK_DATA ?? '{"lists":{},"tasks":{}}')
const flag = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1] ?? null
}

function out(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`)
}

if (args.includes('--version')) {
  out('lark-cli version 9.9.9-stub')
  process.exit(0)
}

if (args[0] === 'auth' && args[1] === 'status') {
  out({
    identity: userReady ? 'user' : 'bot',
    identities: {
      bot: { status: 'ready', available: true },
      user: {
        status: userReady ? 'ready' : 'missing',
        available: userReady,
        userName: '测试用户',
        openId: 'ou_stub',
        scope: userReady
          ? 'task:task:read task:task:write task:tasklist:read task:tasklist:write'
          : 'task:task:read',
        expiresAt: '2099-01-01T00:00:00+08:00',
        refreshExpiresAt: '2099-02-01T00:00:00+08:00'
      }
    }
  })
  process.exit(0)
}

if (args[0] === 'auth' && args[1] === 'qrcode') {
  out('##STUB-QR##')
  process.exit(0)
}

if (args[0] === 'auth' && args[1] === 'login' && args.includes('--no-wait')) {
  out({ device_code: 'stub-device', verification_url: 'https://example.invalid/verify?code=1', expires_in: 600 })
  process.exit(0)
}

if (args[0] === 'auth' && args[1] === 'login') {
  process.exit(0)
}

if (args[0] === 'task' && args[1] === 'tasklists' && args[2] === 'list') {
  if (!userReady) {
    out({ ok: false, error: { type: 'auth', message: 'user refresh_token expired' } })
    process.exit(1)
  }
  out({ ok: true, data: { items: [{ guid: 'g_urgent', name: '清单 A' }, { guid: 'g_calm', name: '清单 B' }] } })
  process.exit(0)
}

if (args[0] === 'task' && args[1] === '+tasklist-create') {
  const name = flag('--name') ?? '未命名'
  out({ ok: true, data: { guid: `g_${name.replace(/\s+/g, '-')}`, name } })
  process.exit(0)
}

if (args[0] === 'task' && args[1] === 'tasklists' && args[2] === 'tasks') {
  const params = JSON.parse(flag('--params') ?? '{}')
  const guids = scenario.lists[params.tasklist_guid] ?? []
  out({ ok: true, data: { items: guids.map((guid) => ({ guid })) } })
  process.exit(0)
}

if (args[0] === 'task' && args[1] === 'tasks' && args[2] === 'get') {
  const params = JSON.parse(flag('--params') ?? '{}')
  out({ ok: true, data: { task: scenario.tasks[params.task_guid] ?? { guid: params.task_guid } } })
  process.exit(0)
}

if (args[0] === 'task' && args[1] === '+create') {
  out({ ok: true, data: { guid: 'gtask_new' } })
  process.exit(0)
}

if (args[0] === 'task' && args[1] === '+update') {
  out({ ok: true, data: {} })
  process.exit(0)
}

if (args[0] === 'task' && (args[1] === '+complete' || args[1] === '+reopen')) {
  out({ ok: true, data: {} })
  process.exit(0)
}

if (args[0] === 'task' && args[1] === 'tasks' && args[2] === 'patch') {
  out({ ok: true, data: {} })
  process.exit(0)
}

// 清单归属的增删都走原始接口：add_tasklist / remove_tasklist
if (args[0] === 'api') {
  out({ ok: true, data: {} })
  process.exit(0)
}

out({ ok: false, error: { message: `stub 未实现: ${args.join(' ')}` } })
process.exit(2)
