// 待办中心与飞书任务清单的双向同步：DSH 是本地 JSON，飞书四个清单承载象限
// 用法：node scripts/feishu-sync.mjs [--dry-run]
import { spawnSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const API = 'http://127.0.0.1:3080/plugins/dsh-4quadrant-todo'
const DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'four-quadrant-todo')
const CONFIG_FILE = path.join(DATA_DIR, 'sync-config.json')
const STATE_FILE = path.join(DATA_DIR, 'sync-state.json')
const LOG_FILE = path.join(DATA_DIR, 'sync.log')

const DRY_RUN = process.argv.includes('--dry-run')
const QUADRANT_IDS = ['urgent-important', 'urgent-not-important', 'not-urgent-important', 'not-urgent-not-important']

const counters = { pushed: 0, pulled: 0, created: 0, conflicts: 0, skipped: 0, unchanged: 0 }

function stamp() {
  return new Date().toISOString()
}

async function writeLog(line) {
  await mkdir(DATA_DIR, { recursive: true })
  await appendFile(LOG_FILE, `[${stamp()}] ${line}\n`, 'utf8')
}

function fail(message) {
  throw new Error(message)
}

async function readJson(file, fallback) {
  const text = await readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  return text === null ? fallback : JSON.parse(text)
}

async function saveState(state) {
  if (DRY_RUN === true) return
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

// 飞书命令行：统一走 lark-cli，输出 JSON 信封，ok 不为 true 就地抛错
function lark(args) {
  const result = spawnSync('lark-cli', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error !== undefined && result.error !== null) fail(`lark-cli 启动失败: ${result.error.message}`)
  if (result.status !== 0) {
    fail(`lark-cli ${args.slice(0, 3).join(' ')} 退出码 ${result.status}: ${String(result.stderr ?? '').slice(0, 400)}`)
  }
  const payload = JSON.parse(result.stdout)
  if (payload.ok !== true) fail(`lark-cli ${args.slice(0, 3).join(' ')} 返回错误: ${payload.error?.message ?? JSON.stringify(payload.error)}`)
  return payload.data
}

async function api(route, body) {
  const options = body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-todo': '1' }, body: JSON.stringify(body) }
  let response
  try {
    response = await fetch(`${API}${route}`, options)
  } catch (error) {
    fail(`${route} 网络请求失败: ${error.message} ${error.cause?.code ?? ''}`)
  }
  const payload = await response.json()
  if (payload.ok !== true) fail(`${route} 失败: ${payload.error}`)
  return payload.value
}

// 本地时区的 ISO 串，与待办中心的 dueAt 写法一致
function toLocalIso(date) {
  const pad = (value) => String(value).padStart(2, '0')
  const minutes = -date.getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function listTasks(listGuid) {
  const tasks = []
  let pageToken = ''
  for (let page = 0; page < 40; page += 1) {
    const params = { tasklist_guid: listGuid, page_size: 100 }
    if (pageToken !== '') params.page_token = pageToken
    const data = lark(['task', 'tasklists', 'tasks', '--params', JSON.stringify(params), '--as', 'user', '--format', 'json'])
    const items = Array.isArray(data.items) ? data.items : []
    for (const item of items) tasks.push(item)
    pageToken = typeof data.page_token === 'string' ? data.page_token : ''
    if (data.has_more !== true || pageToken === '') break
  }
  return tasks
}

function taskDetail(guid) {
  const data = lark(['task', 'tasks', 'get', '--params', JSON.stringify({ task_guid: guid }), '--as', 'user', '--format', 'json'])
  return data.task
}

// 飞书任务归一化成本地可比对的三项：标题、描述、截止、完成
function fromLark(task) {
  const dueAt = task.due !== undefined && task.due !== null && task.due.timestamp !== undefined
    ? toLocalIso(new Date(Number(task.due.timestamp)))
    : null
  const done = task.completed_at !== undefined && task.completed_at !== null && task.completed_at !== '0'
  return {
    title: task.summary ?? '',
    description: task.description ?? '',
    dueAt,
    done,
    completedAt: done ? toLocalIso(new Date(Number(task.completed_at))) : null
  }
}

function fromDsh(todo) {
  return {
    title: todo.title,
    description: todo.description ?? '',
    dueAt: todo.dueAt ?? null,
    done: todo.status === 'done',
    completedAt: todo.completedAt ?? null
  }
}

function dshUpdatedMs(todo) {
  const value = todo.updatedAt ?? todo.createdAt
  return value === undefined || value === null ? 0 : Date.parse(value)
}

function larkUpdatedMs(task) {
  return task.updated_at === undefined ? 0 : Number(task.updated_at)
}

async function pushFields(guid, before, after) {
  const args = ['task', '+update', '--task-id', guid, '--as', 'user', '--format', 'json']
  let changed = false
  if (before.title !== after.title) {
    args.push('--summary', after.title)
    changed = true
  }
  if (before.dueAt !== after.dueAt) {
    if (after.dueAt === null) {
      // 清空截止时间只能用原始接口传空对象
      lark(['task', 'tasks', 'patch', '--params', JSON.stringify({ task_guid: guid }), '--data', JSON.stringify({ due: null }), '--as', 'user', '--format', 'json'])
    } else {
      args.push('--due', after.dueAt)
      changed = true
    }
  }
  if (before.description !== after.description) {
    if (after.description === '') {
      lark(['task', 'tasks', 'patch', '--params', JSON.stringify({ task_guid: guid }), '--data', JSON.stringify({ description: '' }), '--as', 'user', '--format', 'json'])
    } else {
      args.push('--description', after.description)
      changed = true
    }
  }
  if (changed === true) lark(args)
}

async function pushDone(guid, done) {
  const shortcut = done === true ? '+complete' : '+reopen'
  lark(['task', shortcut, '--task-id', guid, '--as', 'user', '--format', 'json'])
}

async function pushList(guid, listGuid) {
  lark(['task', 'tasks', 'patch', '--params', JSON.stringify({ task_guid: guid }), '--data', JSON.stringify({ tasklists: [{ tasklist_guid: listGuid }] }), '--as', 'user', '--format', 'json'])
}

async function createLarkTask(todo, listGuid) {
  const args = ['task', '+create', '--summary', todo.title, '--tasklist-id', listGuid, '--as', 'user', '--format', 'json']
  if (todo.description !== '') args.push('--description', todo.description)
  if (todo.dueAt !== null && todo.dueAt !== undefined) args.push('--due', todo.dueAt)
  const data = lark(args)
  const guid = data.guid ?? data.task?.guid
  if (typeof guid !== 'string' || guid === '') fail('飞书创建任务没有返回 guid')
  if (todo.status === 'done') await pushDone(guid, true)
  return guid
}

async function createDshTodo(task, quadrant) {
  const dueAt = task.due !== undefined && task.due !== null && task.due.timestamp !== undefined
    ? toLocalIso(new Date(Number(task.due.timestamp)))
    : null
  const value = await api('/create', {
    title: task.summary,
    description: task.description ?? '',
    dueAt,
    quadrant,
    source: { kind: 'manual' },
    tags: []
  })
  const done = task.completed_at !== undefined && task.completed_at !== null && task.completed_at !== '0'
  if (done === true) await api('/complete', { ids: [value.focusId], includeChildren: true })
  return value.focusId
}

async function main() {
  const config = await readJson(CONFIG_FILE, null)
  if (config === null) fail(`缺少同步配置 ${CONFIG_FILE}，需要写 lists 字段映射四个象限到飞书清单 guid`)
  const lists = config.lists ?? {}
  for (const quadrant of QUADRANT_IDS) {
    if (typeof lists[quadrant] !== 'string' || lists[quadrant] === '') fail(`同步配置里缺少象限 ${quadrant} 对应的飞书清单 guid`)
  }

  const state = await readJson(STATE_FILE, { version: 1, items: {} })
  const snapshot = await api('/snapshot')
  const todos = (snapshot.todos ?? []).filter((todo) => todo.parentId === null)
  const byId = new Map(todos.map((todo) => [todo.id, todo]))

  // 拉飞书四个清单的任务详情
  const larkTasks = new Map()
  const guidToList = new Map()
  for (const quadrant of QUADRANT_IDS) {
    const listGuid = lists[quadrant]
    for (const row of listTasks(listGuid)) {
      if (typeof row.guid !== 'string') continue
      const detail = taskDetail(row.guid)
      larkTasks.set(row.guid, detail)
      guidToList.set(row.guid, quadrant)
    }
  }

  const mappedGuid = new Map()
  for (const [id, record] of Object.entries(state.items)) mappedGuid.set(record.guid, id)

  // 一、本地有、飞书没有映射的条目：建飞书任务；同名任务已存在时直接认领，避免重跑产生重复
  for (const todo of todos) {
    const record = state.items[todo.id]
    if (record !== undefined) continue
    const quadrant = quadrantOf(todo, lists)
    if (quadrant === null) {
      counters.skipped += 1
      continue
    }
    const now = fromDsh(todo)
    const claimed = [...larkTasks.entries()].find(([guid, task]) => mappedGuid.has(guid) === false
      && guidToList.get(guid) === quadrant
      && task.summary === todo.title)
    if (claimed !== undefined) {
      state.items[todo.id] = { guid: claimed[0], quadrant, lark: fromLark(claimed[1]), dsh: now, syncedAt: stamp() }
      mappedGuid.set(claimed[0], todo.id)
      await saveState(state)
      counters.skipped += 1
      continue
    }
    if (DRY_RUN === true) {
      counters.created += 1
      continue
    }
    const guid = await createLarkTask(todo, lists[quadrant])
    state.items[todo.id] = { guid, quadrant, lark: now, dsh: now, syncedAt: stamp() }
    mappedGuid.set(guid, todo.id)
    await saveState(state)
    counters.created += 1
  }

  // 二、已有映射：比较两侧变化
  for (const [id, record] of Object.entries(state.items)) {
    const todo = byId.get(id)
    const task = larkTasks.get(record.guid)
    if (todo === undefined) {
      // 本地删除了：从飞书清单移出，任务本身保留
      if (task !== undefined && DRY_RUN !== true) await pushList(record.guid, lists[record.quadrant])
      delete state.items[id]
      counters.skipped += 1
      continue
    }
    if (task === undefined) {
      // 飞书侧移出清单或被删除：解除映射，本地保留
      delete state.items[id]
      counters.skipped += 1
      continue
    }
    const dshNow = fromDsh(todo)
    const larkNow = fromLark(task)
    const dshChanged = sameValue(record.dsh, dshNow) === false
    const larkChanged = sameValue(record.lark, larkNow) === false
    if (dshChanged === false && larkChanged === false) {
      counters.unchanged += 1
      continue
    }

    const quadrant = quadrantOf(todo, lists) ?? record.quadrant
    if (larkChanged === false) {
      if (DRY_RUN !== true) {
        await pushFields(record.guid, record.lark, dshNow)
        if (record.lark.done !== dshNow.done) await pushDone(record.guid, dshNow.done)
        if (quadrant !== record.quadrant) await pushList(record.guid, lists[quadrant])
      }
      record.dsh = dshNow
      record.lark = dshNow
      record.quadrant = quadrant
      record.syncedAt = stamp()
      counters.pushed += 1
      continue
    }
    if (dshChanged === false) {
      if (DRY_RUN !== true) {
        await api('/update', {
          id,
          title: larkNow.title,
          description: larkNow.description,
          dueAt: larkNow.dueAt
        })
        if (larkNow.done === true) await api('/complete', { ids: [id], includeChildren: true })
        else await api('/reopen', { ids: [id] })
        if (quadrant !== record.quadrant) await api('/setQuadrant', { ids: [id], quadrant })
      }
      record.dsh = larkNow
      record.lark = larkNow
      record.quadrant = quadrant
      record.syncedAt = stamp()
      counters.pulled += 1
      continue
    }

    // 两侧都改过：时间较新的一方为准
    counters.conflicts += 1
    const dshTime = dshUpdatedMs(todo)
    const larkTime = larkUpdatedMs(task)
    if (larkTime > dshTime) {
      if (DRY_RUN !== true) {
        await api('/update', { id, title: larkNow.title, description: larkNow.description, dueAt: larkNow.dueAt })
        if (larkNow.done === true) await api('/complete', { ids: [id], includeChildren: true })
        else await api('/reopen', { ids: [id] })
      }
      record.dsh = larkNow
      record.lark = larkNow
      counters.pulled += 1
    } else {
      if (DRY_RUN !== true) {
        await pushFields(record.guid, record.lark, dshNow)
        if (record.lark.done !== dshNow.done) await pushDone(record.guid, dshNow.done)
      }
      record.dsh = dshNow
      record.lark = dshNow
      counters.pushed += 1
    }
    record.syncedAt = stamp()
    await writeLog(`冲突按较新一方处理：${todo.title}`)
  }

  // 三、飞书清单里有、本地没有映射的条目：拉进待办中心；同标题已在本地时按重复副本处理，不重复建
  for (const [guid, task] of larkTasks.entries()) {
    if (mappedGuid.has(guid) === true) continue
    if (Object.values(state.items).some((record) => record.guid === guid)) continue
    if (todos.some((todo) => todo.title === task.summary)) {
      counters.skipped += 1
      continue
    }
    const quadrant = guidToList.get(guid)
    if (DRY_RUN === true) {
      counters.pulled += 1
      continue
    }
    const id = await createDshTodo(task, quadrant)
    const normalized = fromLark(task)
    state.items[id] = { guid, quadrant, lark: normalized, dsh: normalized, syncedAt: stamp() }
    await saveState(state)
    counters.pulled += 1
  }

  state.lastRunAt = stamp()
  await saveState(state)
  const summary = `同步完成：新建 ${counters.created}，推送 ${counters.pushed}，拉取 ${counters.pulled}，未变化 ${counters.unchanged}，跳过 ${counters.skipped}，冲突 ${counters.conflicts}${DRY_RUN === true ? '（预演，未写入）' : ''}`
  await writeLog(summary)
  console.log(summary)
}

// 本地条目所属象限：条目自身的 quadrant 必须在清单映射里，否则跳过
function quadrantOf(todo, lists) {
  if (typeof todo.quadrant === 'string' && lists[todo.quadrant] !== undefined) return todo.quadrant
  return null
}

main().catch(async (error) => {
  await writeLog(`同步失败：${error.message}`)
  console.error(`同步失败：${error.message}`)
  process.exitCode = 1
})
