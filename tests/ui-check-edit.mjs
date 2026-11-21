// 编辑面板的截止时间保存与主色按钮悬停对比度检查
import { setTimeout as delay } from 'node:timers/promises'
import {
  apiPost,
  apiSnapshot,
  clickByLabel,
  clickByText,
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

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/
const SCOPE = "document.querySelector('.tc-modal') || document.querySelector('.tc-editor')"

function offsetSuffix() {
  const minutes = -new Date().getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const pad = (value) => String(value).padStart(2, '0')
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

const appUrl = await readServerUrl()
const before = await apiSnapshot()
if (before.dataVersion === undefined) {
  console.log('Host 2.0 路由未就绪: GET /snapshot 缺少 dataVersion，先重启 3080 再运行本套件')
  process.exit(2)
}

const TITLE = '截止时间联调'
const DAY = '2026-12-31'
const beforeIds = before.todos.map((todo) => todo.id)

// 等到接口里的这条待办满足条件，写入较慢时也不会误判
async function waitTodo(id, predicate, timeoutMs) {
  return waitTodoList((snapshot) => {
    const todo = snapshot.todos.find((item) => item.id === id)
    return todo !== undefined && predicate(todo) === true
  }, timeoutMs)
}

async function waitTodoList(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let snapshot = await apiSnapshot()
  while (Date.now() < deadline) {
    if (predicate(snapshot) === true) return snapshot
    await delay(250)
    snapshot = await apiSnapshot()
  }
  return snapshot
}

const { browser, cdp } = await launchAndConnect(appUrl)
let ownErrors = []

try {
  await waitFor(cdp, "document.querySelector('.tc-icon-wrap') !== null", '侧栏图标出现', 40000)
  const opened = await clickByLabel(cdp, '待办中心')
  check('E1 侧栏入口可打开面板', '入口可点击', `点击结果 ${opened}`, opened === true)
  await waitFor(cdp, "document.querySelector('.tc-page') !== null", '待办中心页面渲染', 30000)

  const addClicked = await clickByLabel(cdp, '在紧急且重要添加待办')
  check('E2 方格添加按钮可点击', '打开添加面板', `点击结果 ${addClicked}`, addClicked === true)
  await waitFor(cdp, "document.querySelector('.tc-drawer') !== null", '添加面板打开', 15000)

  const fillResult = await cdp.evaluate(`
    (() => {
      const scope = ${SCOPE}
      const setValue = (element, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value)
        element.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const title = scope.querySelector('input[aria-label="标题"]')
      const date = scope.querySelector('input[aria-label="截止日期"]')
      const time = scope.querySelector('input[aria-label="截止时刻"]')
      if (title === null || date === null || time === null) return JSON.stringify({ ok: false })
      setValue(title, '${TITLE}')
      setValue(date, '${DAY}')
      setValue(time, '14:00')
      return JSON.stringify({ ok: true })
    })()
  `)
  check('E3 添加面板可填入标题与截止时刻', '三个控件都写入', fillResult, JSON.parse(fillResult).ok === true)

  await clickByText(cdp, '.tc-drawer-foot', '添加')
  await waitFor(cdp, "document.querySelector('.tc-drawer') === null", '添加后抽屉关闭', 30000)
  const afterCreate = await waitTodoList((snapshot) => snapshot.todos.some((todo) => todo.title === TITLE && beforeIds.includes(todo.id) === false), 20000)
  const created = afterCreate.todos.find((todo) => todo.title === TITLE && beforeIds.includes(todo.id) === false)
  const expectedCreate = `${DAY}T14:00:00${offsetSuffix()}`
  check(
    'E4 带时刻的待办保存为带时区标识的时间',
    `dueAt 等于 ${expectedCreate}`,
    `dueAt ${created === undefined ? '(未创建)' : created.dueAt}`,
    created !== undefined && created.dueAt === expectedCreate
  )

  const createError = await cdp.evaluate(`
    (() => {
      const node = document.querySelector('.tc-parse-error')
      return node === null ? '' : node.innerText
    })()
  `)
  check('E5 保存后没有错误提示', '提示为空', `提示文本 ${createError}`, createError === '')

  if (created !== undefined) {
    const reopened = await cdp.evaluate(`
      (() => {
        const card = document.querySelector('[data-tc-todo-id="${created.id}"]')
        if (card === null) return false
        const button = card.querySelector('.tc-card-title-button')
        if (button === null) return false
        button.click()
        return true
      })()
    `)
    check('E6 点击卡片标题打开修改面板', '面板以修改模式打开', `点击结果 ${reopened}`, reopened === true)
    await waitFor(cdp, "document.querySelector('.tc-modal') !== null", '修改面板出现', 15000)
    await delay(500)

    const modalTitle = await cdp.evaluate("document.querySelector('.tc-modal .tc-modal-title') === null ? '' : document.querySelector('.tc-modal .tc-modal-title').innerText")
    check('E7 修改面板标题为编辑待办', '标题文本为编辑待办', `标题 ${modalTitle}`, modalTitle === '编辑待办')

    const changed = await cdp.evaluate(`
      (() => {
        const scope = ${SCOPE}
        if (scope === null) return JSON.stringify({ ok: false, reason: '面板未打开' })
        const time = scope.querySelector('input[aria-label="截止时刻"]')
        if (time === null) return JSON.stringify({ ok: false, reason: '没有截止时刻控件' })
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(time, '16:45')
        time.dispatchEvent(new Event('input', { bubbles: true }))
        return JSON.stringify({ ok: true, after: time.value })
      })()
    `)
    check('E8 修改面板可改动截止时刻', '时刻控件写入 16:45', changed, JSON.parse(changed).ok === true)
    await delay(300)
    const kept = JSON.parse(await cdp.evaluate(`
      (() => {
        const modals = [...document.querySelectorAll('.tc-modal')]
        const scope = modals.find((node) => node.querySelector('input[aria-label="截止时刻"]') !== null) ?? null
        const time = scope === null ? null : scope.querySelector('input[aria-label="截止时刻"]')
        return JSON.stringify({ count: modals.length, className: scope === null ? null : scope.className, time: time === null ? null : time.value })
      })()
    `))
    check('E8b 时刻改动在面板里保持住', '控件里仍是 16:45', JSON.stringify(kept), kept.time === '16:45')

    await clickByText(cdp, '.tc-modal-actions', '保存')
    const expectedEdit = `${DAY}T16:45:00${offsetSuffix()}`
    const afterEdit = await waitTodo(created.id, (todo) => todo.dueAt === expectedEdit, 20000)
    const edited = afterEdit.todos.find((todo) => todo.id === created.id)
    const twins = afterEdit.todos.filter((todo) => todo.title === TITLE).map((todo) => `${todo.id} 于 ${todo.dueAt}`)
    check(
      'E9 修改后的截止时间保存成功',
      `dueAt 等于 ${expectedEdit}`,
      `dueAt ${edited === undefined ? '(条目缺失)' : edited.dueAt}；同标题条目 ${twins.join(' | ')}`,
      edited !== undefined && edited.dueAt === expectedEdit
    )
    check(
      'E10 保存的时间带时区标识且不含 NaN',
      '形如 2026-12-31T16:45:00+08:00',
      `dueAt ${edited === undefined ? '(条目缺失)' : edited.dueAt}`,
      edited !== undefined && ISO_PATTERN.test(edited.dueAt) && edited.dueAt.includes('NaN') === false
    )

    const modalGone = await cdp.evaluate("document.querySelector('.tc-modal') === null")
    check('E11 保存后修改面板关闭', '面板已关闭', `面板仍存在 ${modalGone === false}`, modalGone === true)

    const pageError = await cdp.evaluate(`
      (() => {
        const node = document.querySelector('.tc-parse-error')
        return node === null ? '' : node.innerText
      })()
    `)
    check('E12 修改保存后没有错误提示', '提示为空', `提示文本 ${pageError}`, pageError === '')

    const repetitions = await cdp.evaluate(`
      (() => {
        const card = document.querySelector('[data-tc-todo-id="${created.id}"]')
        if (card === null) return false
        card.querySelector('.tc-card-title-button').click()
        return true
      })()
    `)
    await delay(600)
    const repeatState = await cdp.evaluate(`
      (() => {
        const scope = ${SCOPE}
        if (scope === null) return JSON.stringify({ ok: false })
        const select = scope.querySelector('select[aria-label="重复频率"]')
        if (select === null) return JSON.stringify({ ok: false, reason: '没有重复频率控件' })
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'weekly')
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return JSON.stringify({ ok: true })
      })()
    `)
    const untilFilled = await cdp.evaluate(`
      (() => {
        const scope = ${SCOPE}
        const until = scope.querySelector('input[aria-label="重复终止日期"]')
        if (until === null) return JSON.stringify({ ok: false, reason: '没有终止日期控件' })
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(until, '2026-12-31')
        until.dispatchEvent(new Event('input', { bubbles: true }))
        return JSON.stringify({ ok: true })
      })()
    `)
    check('E13 修改面板可设置重复与终止日期', '两个控件都写入', `${repeatState} ${untilFilled}`, JSON.parse(repeatState).ok === true && JSON.parse(untilFilled).ok === true)
    if (JSON.parse(repeatState).ok === true && JSON.parse(untilFilled).ok === true) {
      await clickByText(cdp, '.tc-modal-actions', '保存')
      await delay(1800)
      const afterRepeat = await apiSnapshot()
      const repeated = afterRepeat.todos.find((todo) => todo.id === created.id)
      const until = repeated === undefined || repeated.recurrence === null ? '' : repeated.recurrence.until
      check(
        'E14 重复终止日期保存为带时区标识的时间',
        'until 形如 2026-12-31T23:59:00+08:00',
        `until ${until}`,
        ISO_PATTERN.test(until) && until === `2026-12-31T23:59:00${offsetSuffix()}`
      )
    } else {
      check('E14 重复终止日期保存为带时区标识的时间', '控件存在时才可验证', '控件缺失', false)
    }

    await apiPost('/remove', { ids: [created.id] })
    await delay(400)

    const movable = await apiPost('/create', {
      title: '象限切换联调',
      description: '',
      dueAt: null,
      quadrant: 'urgent-important',
      source: { kind: 'manual' },
      tags: []
    })
    const movableId = movable.focusId
    await cdp.evaluate("window.dispatchEvent(new Event('focus'))")
    await waitFor(cdp, `document.querySelector('[data-tc-todo-id="${movableId}"]') !== null`, '换象限用的卡片出现', 15000)
    await cdp.evaluate(`
      (() => {
        const card = document.querySelector('[data-tc-todo-id="${movableId}"]')
        card.querySelector('.tc-card-title-button').click()
        return true
      })()
    `)
    await waitFor(cdp, "document.querySelector('.tc-drawer') !== null", '修改抽屉出现', 15000)
    await delay(500)
    const picked = await cdp.evaluate(`
      (() => {
        const chip = document.querySelector('[data-tc-quadrant-option="urgent-not-important"]')
        if (chip === null) return JSON.stringify({ ok: false })
        chip.click()
        return JSON.stringify({ ok: true, checked: chip.getAttribute('aria-checked') })
      })()
    `)
    await delay(200)
    await clickByText(cdp, '.tc-drawer-foot', '保存')
    const movedSnapshot = await waitTodo(movableId, (todo) => todo.quadrant === 'urgent-not-important', 20000)
    const movedTodo = movedSnapshot.todos.find((todo) => todo.id === movableId)
    check(
      'E14b 修改抽屉里点象限选项即可换格',
      '接口里的象限变成紧急不重要',
      `点击 ${picked} 象限 ${movedTodo === undefined ? '(缺失)' : movedTodo.quadrant}`,
      JSON.parse(picked).ok === true && movedTodo !== undefined && movedTodo.quadrant === 'urgent-not-important'
    )
    await apiPost('/remove', { ids: [movableId] })
    await delay(400)
  } else {
    for (const name of ['E6 点击卡片标题打开修改面板', 'E7 修改面板标题为编辑待办', 'E8 修改面板可改动截止时刻', 'E9 修改后的截止时间保存成功', 'E10 保存的时间带时区标识且不含 NaN', 'E11 保存后修改面板关闭', 'E12 修改保存后没有错误提示', 'E13 修改面板可设置重复与终止日期', 'E14 重复终止日期保存为带时区标识的时间', 'E14b 修改抽屉里点象限选项即可换格']) {
      check(name, '条目已创建时才可验证', '条目未创建', false)
    }
  }

  const addAgain = await clickByLabel(cdp, '在紧急且重要添加待办')
  await waitFor(cdp, "document.querySelector('.tc-drawer') !== null", '添加面板再次打开', 15000)
  const buttonBox = await cdp.evaluate(`
    (() => {
      const scope = ${SCOPE}
      if (scope === null) return ''
      const button = scope.querySelector('.tc-button-primary')
      if (button === null) return ''
      const rect = button.getBoundingClientRect()
      return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
    })()
  `)
  check('E15 编辑面板里有主色按钮', '找到添加或保存按钮', `${addAgain} ${buttonBox}`, addAgain === true && buttonBox !== '')

  if (buttonBox !== '') {
    const box = JSON.parse(buttonBox)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 })
    await delay(400)
    const colors = JSON.parse(await cdp.evaluate(`
      (() => {
        const scope = ${SCOPE}
        const button = scope.querySelector('.tc-button-primary')
        const style = getComputedStyle(button)
        const luminance = (text) => {
          const scale = text.startsWith('color(srgb') ? 1 : 255
          const parts = text.match(/[\\d.]+/g).slice(0, 3).map((value) => Number(value) / scale)
          const convert = (value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
          const [r, g, b] = parts.map(convert)
          return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        const front = luminance(style.color)
        const back = luminance(style.backgroundColor)
        const contrast = (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05)
        return JSON.stringify({ color: style.color, background: style.backgroundColor, contrast: Number(contrast.toFixed(2)) })
      })()
    `))
    check(
      'E16 主色按钮悬停时文字对比度不低于 4.5',
      '对比度不低于 4.5',
      `前景 ${colors.color} 背景 ${colors.background} 对比度 ${colors.contrast}`,
      colors.contrast >= 4.5
    )
    console.log(`观察: 悬停配色 前景 ${colors.color} 背景 ${colors.background} 对比度 ${colors.contrast}`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, buttons: 0 })
  } else {
    check('E16 主色按钮悬停时文字对比度不低于 4.5', '按钮存在时才可验证', '按钮缺失', false)
  }

  await clickByText(cdp, '.tc-drawer-foot', '取消')
  await delay(400)

  ownErrors = (cdp.consoleErrors ?? []).filter((text) => !text.includes('favicon') && !text.includes('open-in-app') && !text.includes('remote.session'))
  check('E17 页面没有本插件的脚本错误', '没有未捕获异常', ownErrors.join(' | '), ownErrors.length === 0)

  const after = await apiSnapshot()
  const createdIds = after.todos.map((todo) => todo.id).filter((id) => beforeIds.includes(id) === false)
  if (createdIds.length > 0) await apiPost('/remove', { ids: createdIds })
  const final = await apiSnapshot()
  check(
    'E18 结束时数据回到运行前',
    `待办 ${before.todos.length} 条`,
    `现状 ${final.todos.length} 条`,
    final.todos.length === before.todos.length && JSON.stringify(final.todos.map((todo) => todo.id).sort()) === JSON.stringify([...beforeIds].sort())
  )
} finally {
  if (cdp !== null) cdp.close()
  browser.kill()
}

console.log('----')
console.log(`共 ${checks} 项，失败 ${results.filter((item) => item.pass !== true).length} 项`)
process.exitCode = results.filter((item) => item.pass !== true).length
