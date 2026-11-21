// 拖拽换象限、拖动已失效卡片后的自动重读、窗口回到前台时的数据重读
import { setTimeout as delay } from 'node:timers/promises'
import {
  apiPost,
  apiSnapshot,
  clickByLabel,
  launchAndConnect,
  readServerUrl,
  waitFor
} from './cdp-harness.mjs'

const results = []
let checks = 0

function check(name, description, actual, pass) {
  checks += 1
  results.push({ name, description, actual, pass })
  console.log(`${pass ? 'ok  ' : 'fail'} ${name}  ${description}`)
  if (!pass) console.log(`      实际: ${actual}`)
}

const FROM = 'urgent-important'
const TO = 'not-urgent-important'

const appUrl = await readServerUrl()
const before = await apiSnapshot()
if (before.dataVersion === undefined) {
  console.log('Host 2.0 路由未就绪: GET /snapshot 缺少 dataVersion，先重启 3080 再运行本套件')
  process.exit(2)
}
const beforeIds = before.todos.map((todo) => todo.id)

const seeded = []
for (const title of ['拖拽检查 甲', '拖拽检查 乙', '拖拽检查 丙']) {
  const created = await apiPost('/create', {
    title,
    description: '',
    dueAt: null,
    quadrant: FROM,
    source: { kind: 'manual' },
    tags: []
  })
  seeded.push(created.focusId)
}
await delay(300)

async function waitApi(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let snapshot = await apiSnapshot()
  while (Date.now() < deadline) {
    if (predicate(snapshot) === true) return snapshot
    await delay(250)
    snapshot = await apiSnapshot()
  }
  return snapshot
}

const DRAG = (id, target) => `
  (() => {
    const card = document.querySelector('[data-tc-todo-id="${id}"]')
    const cell = document.querySelector('[data-tc-quadrant="${target}"]')
    if (card === null || cell === null) return JSON.stringify({ ok: false })
    const transfer = new DataTransfer()
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    cell.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    cell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    return JSON.stringify({ ok: true, payload: transfer.getData('text/plain') })
  })()
`

const query = (id) => `
  (() => {
    const card = document.querySelector('[data-tc-todo-id="${id}"]')
    if (card === null) return JSON.stringify({ exists: false })
    const cell = card.closest('.tc-cell')
    return JSON.stringify({
      exists: true,
      draggable: card.getAttribute('draggable'),
      quadrant: cell === null ? null : cell.getAttribute('data-tc-quadrant')
    })
  })()
`

const BANNER = `
  (() => {
    const node = document.querySelector('.tc-banner-error .tc-banner-text')
    return node === null ? '' : node.innerText
  })()
`

const { browser, cdp } = await launchAndConnect(appUrl)
let ownErrors = []

try {
  await waitFor(cdp, "document.querySelector('.tc-icon-wrap') !== null", '侧栏图标出现', 40000)
  await clickByLabel(cdp, '待办中心')
  await waitFor(cdp, "document.querySelector('.tc-page') !== null", '页面渲染', 30000)
  await waitFor(cdp, `document.querySelectorAll('.tc-cell[data-tc-quadrant="${FROM}"] .tc-card').length >= 3`, '卡片出现', 20000)

  const first = JSON.parse(await cdp.evaluate(query(seeded[0])))
  check('G1 卡片渲染在开始所在的格子里', `卡片位于 ${FROM}`, JSON.stringify(first), first.exists === true && first.quadrant === FROM)
  check('G2 卡片带可拖拽属性', 'draggable 为 true', `draggable ${first.draggable}`, first.draggable === 'true')

  const dragged = JSON.parse(await cdp.evaluate(DRAG(seeded[0], TO)))
  check('G3 拖拽把待办标识交给目标格子', `载荷为 ${seeded[0]}`, JSON.stringify(dragged), dragged.ok === true && dragged.payload === seeded[0])

  const moved = await waitApi((snapshot) => snapshot.todos.some((item) => item.id === seeded[0] && item.quadrant === TO), 15000)
  const movedTodo = moved.todos.find((item) => item.id === seeded[0])
  check('G4 拖拽后接口里的象限已改变', `象限为 ${TO}`, `象限 ${movedTodo === undefined ? '(缺失)' : movedTodo.quadrant}`, movedTodo !== undefined && movedTodo.quadrant === TO)

  await waitFor(cdp, `(() => {
    const card = document.querySelector('[data-tc-todo-id="${seeded[0]}"]')
    return card !== null && card.closest('.tc-cell').getAttribute('data-tc-quadrant') === '${TO}'
  })()`, '卡片换到目标格子', 15000)
  const placed = JSON.parse(await cdp.evaluate(query(seeded[0])))
  check('G5 拖拽后卡片出现在目标格子', `卡片位于 ${TO}`, JSON.stringify(placed), placed.exists === true && placed.quadrant === TO)

  const successBanner = await cdp.evaluate(BANNER)
  check('G6 拖拽成功时没有错误提示', '提示为空', `提示 ${successBanner}`, successBanner === '')

  await cdp.evaluate(DRAG(seeded[1], FROM))
  const sameCell = await waitApi((snapshot) => snapshot.todos.some((item) => item.id === seeded[1] && item.quadrant === FROM), 15000)
  const sameTodo = sameCell.todos.find((item) => item.id === seeded[1])
  check('G7 拖回原格子不改变象限', `象限仍为 ${FROM}`, `象限 ${sameTodo === undefined ? '(缺失)' : sameTodo.quadrant}`, sameTodo !== undefined && sameTodo.quadrant === FROM)

  const late = await apiPost('/create', {
    title: '拖拽检查 丁',
    description: '',
    dueAt: null,
    quadrant: FROM,
    source: { kind: 'manual' },
    tags: []
  })
  const lateId = late.focusId
  seeded.push(lateId)
  await cdp.evaluate("window.dispatchEvent(new Event('focus'))")
  await waitFor(cdp, `document.querySelector('[data-tc-todo-id="${lateId}"]') !== null`, '聚焦后出现新卡片', 15000)
  check('G8 窗口回到前台时读回文件里的新条目', '新建的卡片出现在页面', `卡片 ${lateId}`, true)

  await apiPost('/remove', { ids: [lateId] })
  await delay(300)
  const staleBefore = JSON.parse(await cdp.evaluate(query(lateId)))
  check('G9 别处删除后页面仍显示旧卡片', '卡片还在页面上', JSON.stringify(staleBefore), staleBefore.exists === true)

  await cdp.evaluate(DRAG(lateId, TO))
  await waitFor(cdp, `(() => {
    const node = document.querySelector('.tc-banner-error .tc-banner-text')
    return node !== null && node.innerText.includes('待办不存在')
  })()`, '出现待办不存在的提示', 15000)
  const staleBanner = await cdp.evaluate(BANNER)
  check('G10 拖动已不存在的待办时给出提示', '提示里带待办标识', `提示 ${staleBanner}`, staleBanner.includes('待办不存在') && staleBanner.includes(lateId))

  await waitFor(cdp, `document.querySelector('[data-tc-todo-id="${lateId}"]') === null`, '失效卡片消失', 15000)
  const staleAfter = JSON.parse(await cdp.evaluate(query(lateId)))
  check('G11 提示之后列表按文件内容更新', '失效卡片从页面移除', JSON.stringify(staleAfter), staleAfter.exists === false)

  const rendered = await cdp.evaluate("document.querySelectorAll('.tc-card').length")
  const fromApi = (await apiSnapshot()).todos.filter((item) => item.parentId === null).length
  check('G12 页面条目数与接口一致', `${fromApi} 张卡片`, `页面上 ${rendered} 张`, rendered === fromApi)

  const polled = await apiPost('/create', {
    title: '拖拽检查 戊',
    description: '',
    dueAt: null,
    quadrant: TO,
    source: { kind: 'manual' },
    tags: []
  })
  seeded.push(polled.focusId)
  // DSH 有时会把主区域切回工作区选择，面板随之卸载；重新点开侧栏图标再等轮询结果
  let polledCard = false
  for (let attempt = 0; attempt < 10 && polledCard === false; attempt += 1) {
    const open = await cdp.evaluate("document.querySelector('.tc-page') !== null")
    if (open !== true) {
      await clickByLabel(cdp, '待办中心')
      await waitFor(cdp, "document.querySelector('.tc-page') !== null", '面板重新打开', 20000)
    }
    await delay(6000)
    polledCard = await cdp.evaluate(`document.querySelector('[data-tc-todo-id="${polled.focusId}"]') !== null`)
  }
  check('G13 轮询把其他窗口写入的条目读回页面', '新卡片在等待窗口期内出现', `卡片 ${polled.focusId} 出现 ${polledCard}`, polledCard === true)

  ownErrors = (cdp.consoleErrors ?? []).filter((text) => !text.includes('favicon') && !text.includes('open-in-app') && !text.includes('remote.session') && !text.includes('Sidebar Session opening failed'))
  check('G14 页面没有本插件的脚本错误', '没有未捕获异常', ownErrors.join(' | '), ownErrors.length === 0)
} finally {
  const after = await apiSnapshot()
  const createdIds = after.todos.map((todo) => todo.id).filter((id) => beforeIds.includes(id) === false)
  if (createdIds.length > 0) await apiPost('/remove', { ids: createdIds })
  if (cdp !== null) cdp.close()
  browser.kill()
}

const final = await apiSnapshot()
check(
  'G15 结束时数据回到运行前',
  `待办 ${before.todos.length} 条`,
  `现状 ${final.todos.length} 条`,
  final.todos.length === before.todos.length
    && JSON.stringify(final.todos.map((todo) => todo.id).sort()) === JSON.stringify([...beforeIds].sort())
)

console.log('----')
console.log(`共 ${checks} 项，失败 ${results.filter((item) => item.pass !== true).length} 项`)
process.exitCode = results.filter((item) => item.pass !== true).length
