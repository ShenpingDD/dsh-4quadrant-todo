#!/usr/bin/env node
// 测试用的 lark-cli 替身：只实现插件用到的子命令，行为由 STUB_LARK_USER 控制
// STUB_LARK_USER=missing（默认）时用户身份未就绪；=ready 时返回可用的清单数据
const args = process.argv.slice(2)
const userReady = (process.env.STUB_LARK_USER ?? 'missing') === 'ready'
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
  out({ ok: true, data: { items: [] } })
  process.exit(0)
}

out({ ok: false, error: { message: `stub 未实现: ${args.join(' ')}` } })
process.exit(2)
