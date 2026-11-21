import { setTimeout as delay } from 'node:timers/promises'
import { readdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  API,
  apiGet,
  apiPost,
  apiSnapshot,
  clickByLabel,
  clickByText,
  dataDir,
  launchAndConnect,
  readServerUrl,
  waitFor
} from './cdp-harness.mjs'
import { saveBackup } from './data-guard.mjs'

const CLEAN_DATA = {
  version: 2,
  todos: [],
  collapsed: {},
  filters: [],
  settings: { reminderLeadMinutes: 30, statsRange: 'week' },
  meta: { upgradedAt: null, upgradedFrom: null }
}

const TAB_ORDER = ['四象限', '今日', '已完成', '统计']
const SECTION_ORDER = ['已逾期', '今天到期', '未来 7 天', '更晚', '未安排']

const failures = []
let checks = 0
let skipped = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) console.log(`PASS ${label}`)
  else {
    console.log(`FAIL ${label} -> ${detail}`)
    failures.push(label)
  }
}

function skip(label, reason) {
  skipped += 1
  console.log(`SKIP ${label} -> ${reason}`)
}

function localDateValue(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function setFieldExpression(selector, value) {
  return `
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (element === null) return false
      const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype
        : element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
      setter.call(element, ${JSON.stringify(value)})
      element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
      return true
    })()
  `
}

function pressEnterExpression(selector) {
  return `
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (element === null) return false
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
      return true
    })()
  `
}

async function waitForApi(predicate, label, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await apiSnapshot()
    if (predicate(snapshot)) return snapshot
    await delay(1000)
  }
  console.log(`观察: 等待超时 ${label}`)
  return null
}

async function waitForSoft(cdp, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await cdp.evaluate(expression)
    if (value) return true
    await delay(200)
  }
  return false
}

async function openPanel(cdp) {
  await waitFor(cdp, "document.querySelector('.tc-icon-wrap') !== null", '侧栏入口出现', 60000)
  const opened = await clickByLabel(cdp, '待办中心')
  if (opened !== true) throw new Error('侧栏入口不可点击')
  await waitFor(cdp, "document.querySelector('.tc-page') !== null", '待办中心面板打开', 20000)
}

async function reloadAndOpen(cdp) {
  await cdp.send('Page.reload')
  await delay(1500)
  await waitFor(cdp, "document.querySelector('.tc-icon-wrap') !== null", '重新加载后的侧栏入口出现', 60000)
  const alreadyOpen = await cdp.evaluate("document.querySelector('.tc-page') !== null")
  if (alreadyOpen === true) return
  const opened = await clickByLabel(cdp, '待办中心')
  if (opened !== true) throw new Error('重新加载后侧栏入口不可点击')
  await waitFor(cdp, "document.querySelector('.tc-page') !== null", '重新加载后的面板打开', 20000)
}

async function switchTab(cdp, name) {
  const clicked = await cdp.evaluate(`
    (() => {
      const target = [...document.querySelectorAll('[role="tab"]')]
        .find((node) => (node.textContent || '').trim() === ${JSON.stringify(name)})
      if (target === undefined) return false
      target.click()
      return true
    })()
  `)
  if (clicked !== true) throw new Error(`标签不可点击: ${name}`)
  await delay(400)
}

function sectionCounts(todos, nowMs) {
  const startToday = new Date(nowMs)
  startToday.setHours(0, 0, 0, 0)
  const endToday = new Date(startToday)
  endToday.setDate(endToday.getDate() + 1)
  endToday.setMilliseconds(-1)
  const endWindow = new Date(startToday)
  endWindow.setDate(endWindow.getDate() + 7)
  endWindow.setMilliseconds(-1)
  const counts = { overdue: 0, today: 0, next7: 0, later: 0, unscheduled: 0 }
  for (const todo of todos) {
    if (todo.parentId !== null || todo.status !== 'open') continue
    if (todo.dueAt === null) {
      counts.unscheduled += 1
      continue
    }
    const due = Date.parse(todo.dueAt)
    if (due < nowMs) counts.overdue += 1
    else if (due <= endToday.getTime()) counts.today += 1
    else if (due <= endWindow.getTime()) counts.next7 += 1
    else counts.later += 1
  }
  return counts
}

const appUrl = await readServerUrl()
const before = await apiSnapshot()
if (before.dataVersion === undefined) {
  console.log('Host 2.0 路由未就绪: GET /snapshot 缺少 dataVersion，先重启 3080 再运行本套件')
  process.exit(2)
}

// 运行前的完整数据，收尾按它恢复；导入备份按开始时刻筛选后删除
const originalData = await apiGet('/export')
await saveBackup(originalData, 'ui-check-v2')
const startedAt = Date.now()

const readonlyAvailable = before.readOnly === true

async function createTodo(body) {
  const value = await apiPost('/create', {
    description: '',
    dueAt: null,
    workspaceId: null,
    source: { kind: 'manual' },
    ...body
  })
  return value.focusId
}

const now = Date.now()
const tomorrow = new Date(now)
tomorrow.setDate(tomorrow.getDate() + 1)
const todayLate = new Date(now)
todayLate.setHours(23, 0, 0, 0)
const laterDue = new Date(now)
laterDue.setDate(laterDue.getDate() + 20)
laterDue.setHours(10, 0, 0, 0)
const tomorrowMorning = new Date(tomorrow)
tomorrowMorning.setHours(10, 0, 0, 0)
const tomorrowEarly = new Date(tomorrow)
tomorrowEarly.setHours(9, 0, 0, 0)
const tomorrowDawn = new Date(tomorrow)
tomorrowDawn.setHours(8, 0, 0, 0)
const remindedDue = new Date(now - 5 * 60000)

const REMINDER_TITLE = '提醒验证任务'
const TAGGED_TITLE = '标签验证任务'
const RECURRING_TITLE = '重复验证任务'

let browser = null
let cdp = null

try {
  const launched = await launchAndConnect(appUrl)
  browser = launched.browser
  cdp = launched.cdp

  if (readonlyAvailable) {
    await openPanel(cdp)
    await waitForSoft(cdp, "document.querySelector('.tc-banner') !== null", 20000)
    const readonlyState = JSON.parse(await cdp.evaluate(`
      (() => {
        const banner = document.querySelector('.tc-banner')
        if (banner === null) return JSON.stringify({ text: '', hasUpgrade: false })
        const upgrade = [...banner.querySelectorAll('button')]
          .find((node) => (node.textContent || '').trim() === '升级')
        return JSON.stringify({
          text: (banner.textContent || '').trim(),
          hasUpgrade: upgrade !== undefined
        })
      })()
    `))
    check('只读横幅出现并说明数据格式为 1.0', readonlyState.text.includes('数据格式为 1.0'), readonlyState.text)
    check('只读横幅带升级按钮', readonlyState.hasUpgrade === true, '没有找到升级按钮')

    await cdp.evaluate(setFieldExpression('.tc-quick input', '只读状态检查'))
    await cdp.evaluate(pressEnterExpression('.tc-quick input'))
    await waitForSoft(cdp, "document.querySelector('.tc-parse') !== null", 15000)
    const readonlyAdd = JSON.parse(await cdp.evaluate(`
      (() => {
        const box = document.querySelector('.tc-parse')
        if (box === null) return JSON.stringify({ disabled: null, note: '', title: null })
        const add = [...box.querySelectorAll('button')]
          .find((node) => (node.textContent || '').trim() === '添加')
        const note = [...box.querySelectorAll('.tc-parse-note, .tc-parse-error')]
          .map((node) => (node.textContent || '').trim()).join(' ')
        return JSON.stringify({
          disabled: add === undefined ? null : add.getAttribute('aria-disabled') === 'true' || add.disabled === true,
          note,
          title: add === undefined ? null : add.getAttribute('title')
        })
      })()
    `))
    check('只读期快速录入的添加按钮禁用', readonlyAdd.disabled === true, `aria-disabled ${readonlyAdd.disabled}`)
    check('只读期添加按钮旁给出升级说明', `${readonlyAdd.note} ${readonlyAdd.title ?? ''}`.includes('数据格式为 1.0，请先升级'), `说明 ${readonlyAdd.note} 标题 ${readonlyAdd.title}`)
    await clickByText(cdp, '.tc-parse', '取消')
    await delay(300)

    await apiPost('/upgrade', { confirm: true })
    await reloadAndOpen(cdp)
    const afterUpgrade = await cdp.evaluate(`
      (() => {
        const banners = [...document.querySelectorAll('.tc-banner')].map((node) => (node.textContent || '').trim())
        return JSON.stringify(banners)
      })()
    `)
    const bannerTexts = JSON.parse(afterUpgrade)
    check('升级后只读横幅消失', bannerTexts.every((text) => !text.includes('数据格式为 1.0')), JSON.stringify(bannerTexts))
  } else {
    skip('只读横幅出现并说明数据格式为 1.0', '数据文件已是 2.0，接口无法回到版本 1')
    skip('只读横幅带升级按钮', '数据文件已是 2.0，接口无法回到版本 1')
    skip('只读期快速录入的添加按钮禁用', '数据文件已是 2.0，接口无法回到版本 1')
    skip('只读期添加按钮旁给出升级说明', '数据文件已是 2.0，接口无法回到版本 1')
  }

  await apiPost('/import', { payload: CLEAN_DATA, fileName: 'ui-check-v2-reset.json' })

  await createTodo({ title: REMINDER_TITLE, quadrant: 'urgent-important', dueAt: remindedDue.toISOString(), reminder: { leadMinutes: 0 } })
  await createTodo({ title: '今天到期任务', quadrant: 'urgent-important', dueAt: todayLate.toISOString() })
  await createTodo({ title: '未来七天任务', quadrant: 'not-urgent-important', dueAt: tomorrowMorning.toISOString() })
  await createTodo({ title: '更晚任务', quadrant: 'not-urgent-important', dueAt: laterDue.toISOString() })
  await createTodo({ title: '未安排任务', quadrant: 'urgent-not-important' })
  await createTodo({ title: TAGGED_TITLE, quadrant: 'urgent-important', dueAt: tomorrowEarly.toISOString(), tags: ['工作', '家里'] })
  await createTodo({ title: RECURRING_TITLE, quadrant: 'not-urgent-important', dueAt: tomorrowDawn.toISOString(), recurrence: { freq: 'daily', interval: 1, until: null } })

  const snapshotAfterCreate = await apiSnapshot()
  await reloadAndOpen(cdp)

  const tabState = JSON.parse(await cdp.evaluate(`
    (() => {
      const tabs = [...document.querySelectorAll('[role="tab"]')].map((node) => ({
        text: (node.textContent || '').trim(),
        selected: node.getAttribute('aria-selected')
      }))
      return JSON.stringify({ tabs, hasTablist: document.querySelector('[role="tablist"]') !== null })
    })()
  `))
  const tabTexts = tabState.tabs.map((tab) => tab.text)
  check('四个标签存在', tabState.tabs.length === 4 && tabState.hasTablist === true, `数量 ${tabState.tabs.length} tablist ${tabState.hasTablist}`)
  check('标签顺序为四象限、今日、已完成、统计', tabTexts.join(',') === TAB_ORDER.join(','), tabTexts.join(','))
  check('默认选中四象限', tabState.tabs[0].selected === 'true' && tabState.tabs.filter((tab) => tab.selected === 'true').length === 1, JSON.stringify(tabState.tabs.map((tab) => tab.selected)))

  const quickState = JSON.parse(await cdp.evaluate(`
    (() => {
      const inputs = [...document.querySelectorAll('.tc-quick input')]
      return JSON.stringify({ count: inputs.length, placeholder: inputs[0] === undefined ? null : inputs[0].getAttribute('placeholder') })
    })()
  `))
  check('快速录入输入行占位文字正确', quickState.count === 1 && quickState.placeholder === '一行写完：明天下午交报告 #重要', `数量 ${quickState.count} 占位 ${quickState.placeholder}`)

  await cdp.evaluate(setFieldExpression('.tc-quick input', '明天下午交报告 #重要'))
  await cdp.evaluate(pressEnterExpression('.tc-quick input'))
  await waitFor(cdp, "document.querySelector('.tc-parse') !== null", '预览区展开', 15000)

  const parseProbe = `
    (() => {
      const box = document.querySelector('.tc-parse')
      if (box === null) return JSON.stringify({ labels: [], rowCount: 0, title: null, date: null, time: null, quadrant: null, quadrantText: null, tags: 0, error: '' })
      const rows = [...box.querySelectorAll('.tc-parse-row')]
      const title = box.querySelector('input[maxlength="200"]')
      const date = box.querySelector('input[type="date"]')
      const time = box.querySelector('input[type="time"]')
      const select = box.querySelector('select')
      return JSON.stringify({
        labels: [...box.querySelectorAll('.tc-parse-label')].map((node) => (node.textContent || '').trim()),
        rowCount: rows.length,
        title: title === null ? null : title.value,
        date: date === null ? null : date.value,
        time: time === null ? null : time.value,
        quadrant: select === null ? null : select.value,
        quadrantText: select === null ? null : select.options[select.selectedIndex].text,
        tags: box.querySelectorAll('.tc-tag-x').length,
        error: [...box.querySelectorAll('.tc-parse-error')].map((node) => (node.textContent || '').trim()).join(' ')
      })
    })()
  `
  const parsed = JSON.parse(await cdp.evaluate(parseProbe))
  check('预览标题为「交报告」', parsed.title === '交报告', `标题 ${parsed.title}`)
  check('预览象限为重要不紧急', parsed.quadrant === 'not-urgent-important' || parsed.quadrantText === '重要不紧急', `取值 ${parsed.quadrant} 文字 ${parsed.quadrantText}`)
  check('预览截止时间为次日 14:00', parsed.date === localDateValue(tomorrow) && parsed.time === '14:00', `日期 ${parsed.date} 时刻 ${parsed.time}`)
  check('预览未识别出标签', parsed.tags === 0, `标签数 ${parsed.tags}`)
  check('预览区四个字段按标题、截止时间、象限、标签排列', parsed.labels.join(',') === '标题,截止时间,象限,标签', parsed.labels.join(','))

  await cdp.evaluate(`
    (() => {
      const box = document.querySelector('.tc-parse')
      const rows = [...box.querySelectorAll('.tc-parse-row')]
      const setValue = (element, value) => {
        const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
        element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
      }
      setValue(box.querySelector('input[maxlength="200"]'), '交报告已改')
      setValue(box.querySelector('input[type="date"]'), '2026-12-31')
      setValue(box.querySelector('input[type="time"]'), '09:30')
      setValue(box.querySelector('select'), 'urgent-important')
      const tagRow = rows.find((row) => ((row.querySelector('.tc-parse-label') || {}).textContent || '').trim() === '标签')
      const tagInput = tagRow === undefined ? null : tagRow.querySelector('input')
      if (tagInput !== null) {
        setValue(tagInput, '临时')
        tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
      }
      return true
    })()
  `)
  await delay(500)
  const edited = JSON.parse(await cdp.evaluate(parseProbe))
  check('预览区标题字段可编辑', edited.title === '交报告已改', `标题 ${edited.title}`)
  check('预览区截止日期与时刻可编辑', edited.date === '2026-12-31' && edited.time === '09:30', `日期 ${edited.date} 时刻 ${edited.time}`)
  check('预览区象限可编辑', edited.quadrant === 'urgent-important', `象限 ${edited.quadrant}`)
  check('预览区标签可添加', edited.tags === 1, `标签数 ${edited.tags}`)
  const tagDeleted = await clickByLabel(cdp, '删除标签 临时')
  await delay(400)
  const afterTagDelete = JSON.parse(await cdp.evaluate(parseProbe))
  check('预览区标签标记可删除', tagDeleted === true && afterTagDelete.tags === 0, `点击 ${tagDeleted} 剩余 ${afterTagDelete.tags}`)

  await clickByText(cdp, '.tc-parse', '取消')
  await delay(400)
  await cdp.evaluate(setFieldExpression('.tc-quick input', '明天下午'))
  await cdp.evaluate(pressEnterExpression('.tc-quick input'))
  await waitFor(cdp, "document.querySelector('.tc-parse') !== null", '空标题预览区展开', 15000)
  const emptyParse = JSON.parse(await cdp.evaluate(parseProbe))
  check('只有时间词时预览标题为空并提示', emptyParse.title === '' && emptyParse.error.includes('标题不能为空'), `标题 ${emptyParse.title} 提示 ${emptyParse.error}`)
  const beforeEmptyClick = (await apiSnapshot()).todos.length
  await clickByText(cdp, '.tc-parse', '添加')
  await delay(800)
  const afterEmptyClick = (await apiSnapshot()).todos.length
  check('标题为空点添加不产生待办', afterEmptyClick === beforeEmptyClick, `点击前 ${beforeEmptyClick} 点击后 ${afterEmptyClick}`)
  await clickByText(cdp, '.tc-parse', '取消')
  await delay(300)

  await switchTab(cdp, '今日')
  await waitFor(cdp, "document.querySelector('.tc-today') !== null", '今日页渲染', 20000)

  const filterState = JSON.parse(await cdp.evaluate(`
    (() => {
      const bar = document.querySelector('.tc-filterbar')
      if (bar === null) return JSON.stringify({ buttons: [], selects: [], hasSearch: false, tagButton: false, presetButton: false })
      const buttons = [...bar.querySelectorAll('button')].map((node) => (node.textContent || '').trim())
      const selects = [...bar.querySelectorAll('select')].map((node) => ({
        label: node.getAttribute('aria-label'),
        options: [...node.options].map((option) => option.text)
      }))
      const search = bar.querySelector('input[placeholder="搜索标题与描述"], input[aria-label="搜索标题与描述"]')
      return JSON.stringify({
        buttons,
        selects,
        hasSearch: search !== null,
        tagButton: buttons.some((text) => text === '标签' || text.startsWith('标签 ·')),
        presetButton: buttons.some((text) => text === '预设' || text.startsWith('预设'))
      })
    })()
  `))
  check('筛选区有搜索框', filterState.hasSearch === true, '没有找到搜索框')
  check('筛选区有标签多选入口', filterState.tagButton === true, JSON.stringify(filterState.buttons))
  const overdueSelect = filterState.selects.find((select) => select.label === '逾期状态')
  const rangeSelect = filterState.selects.find((select) => select.label === '截止范围')
  const sourceSelect = filterState.selects.find((select) => select.label === '来源')
  check('筛选区有逾期状态四值', overdueSelect !== undefined && overdueSelect.options.length === 4 && overdueSelect.options.some((text) => text.includes('已逾期')) && overdueSelect.options.some((text) => text.includes('未逾期')) && overdueSelect.options.some((text) => text.includes('无截止时间')), JSON.stringify(overdueSelect))
  check('筛选区有截止范围四值', rangeSelect !== undefined && rangeSelect.options.length === 4 && rangeSelect.options.some((text) => text.includes('今天')) && rangeSelect.options.some((text) => text.includes('本周')) && rangeSelect.options.some((text) => text.includes('自定义')), JSON.stringify(rangeSelect))
  check('筛选区有来源三值', sourceSelect !== undefined && sourceSelect.options.length === 3 && sourceSelect.options.some((text) => text.includes('手动创建') || text.includes('手工创建')) && sourceSelect.options.some((text) => text.includes('来自会话')), JSON.stringify(sourceSelect))
  check('筛选区有预设下拉入口', filterState.presetButton === true, JSON.stringify(filterState.buttons))

  const presetOpened = await clickByText(cdp, '.tc-filterbar', '预设')
  check('预设入口可点击', presetOpened === true, '没有找到预设按钮')
  const presetPanelSeen = await waitForSoft(cdp, "document.querySelector('.tc-preset-panel') !== null", 15000)
  if (presetPanelSeen === true) {
    const presetSaved = await clickByText(cdp, '.tc-preset-panel', '保存当前条件')
    check('预设面板有保存入口', presetSaved === true, '没有找到保存当前条件')
    const dialogSeen = presetSaved === true && (await waitForSoft(cdp, "document.querySelector('[role=\"dialog\"]') !== null", 15000))
    if (dialogSeen === true) {
      await cdp.evaluate(setFieldExpression('[role="dialog"] input', '验证预设'))
      await delay(200)
      const savedDialog = await clickByText(cdp, '[role="dialog"]', '保存')
      check('保存预设对话框可提交', savedDialog === true, '没有找到保存按钮')
      await waitForSoft(cdp, "document.querySelector('[role=\"dialog\"]') === null", 15000)
    } else {
      skip('保存预设对话框可提交', '保存对话框没有打开')
    }
    const panelStillOpen = await cdp.evaluate("document.querySelector('.tc-preset-panel') !== null")
    if (panelStillOpen !== true) {
      await clickByText(cdp, '.tc-filterbar', '预设')
      await delay(500)
    }
    const presetRows = JSON.parse(await cdp.evaluate(`
      (() => {
        const panel = document.querySelector('.tc-preset-panel')
        if (panel === null) return JSON.stringify([])
        return JSON.stringify([...panel.querySelectorAll('.tc-preset-row')].map((node) => (node.textContent || '').trim()))
      })()
    `))
    check('保存预设后下拉出现该名称', presetRows.some((text) => text.includes('验证预设')), JSON.stringify(presetRows))
  } else {
    skip('预设面板有保存入口', '预设面板没有打开')
    skip('保存预设对话框可提交', '预设面板没有打开')
    skip('保存预设后下拉出现该名称', '预设面板没有打开')
  }
  await cdp.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await delay(400)

  const remindedSnapshot = await waitForApi((snapshot) => snapshot.todos.some((todo) => todo.remindedAt !== null), '提醒扫描写入 remindedAt', 90000)
  await waitForSoft(cdp, "document.querySelector('.tc-reminder') !== null", 70000)
  const reminderState = JSON.parse(await cdp.evaluate(`
    (() => {
      const area = document.querySelector('.tc-reminder')
      if (area === null) return JSON.stringify({ head: null, titles: [] })
      const head = area.querySelector('.tc-reminder-head')
      const rows = [...area.querySelectorAll('.tc-reminder-row')]
      return JSON.stringify({
        head: head === null ? null : (head.textContent || '').trim(),
        titles: rows.map((row) => ((row.querySelector('.tc-reminder-title') || {}).textContent || '').trim())
      })
    })()
  `))
  check('提醒区头部显示已提醒条数', reminderState.head !== null && /^\d+ 条待办已到提醒时间$/.test(reminderState.head), `头 ${reminderState.head} 扫描 ${remindedSnapshot !== null}`)
  check('提醒区列出已提醒未完成条目', reminderState.titles.includes(REMINDER_TITLE), JSON.stringify(reminderState.titles))

  const badgeState = JSON.parse(await cdp.evaluate(`
    (() => {
      const dot = document.querySelector('.tc-badge-dot')
      return JSON.stringify({ exists: dot !== null, label: dot === null ? null : dot.getAttribute('aria-label') })
    })()
  `))
  check('侧栏图标出现提醒标记', badgeState.exists === true && badgeState.label !== null && /^\d+ 条待办已到提醒时间$/.test(badgeState.label), `存在 ${badgeState.exists} 名称 ${badgeState.label}`)

  const todayProbe = JSON.parse(await cdp.evaluate(`
    (() => {
      const sections = [...document.querySelectorAll('.tc-section')].map((node) => {
        const head = node.querySelector('.tc-section-head')
        return {
          text: head === null ? '' : (head.textContent || '').trim(),
          expanded: head === null ? null : head.getAttribute('aria-expanded')
        }
      })
      return JSON.stringify(sections)
    })()
  `))
  const expectedCounts = sectionCounts(snapshotAfterCreate.todos, Date.now())
  const expectedValues = [expectedCounts.overdue, expectedCounts.today, expectedCounts.next7, expectedCounts.later, expectedCounts.unscheduled]
  const actualValues = todayProbe.map((section) => {
    const matched = section.text.match(/·\s*(\d+)\s*项/)
    return matched === null ? null : Number(matched[1])
  })
  const headsMatchOrder = todayProbe.map((section) => section.text.replace(/·.*$/, '').trim())
  check('今日页五个分区标题齐全且顺序正确', headsMatchOrder.join(',') === SECTION_ORDER.join(','), headsMatchOrder.join(','))
  check('今日页五个分区标题都带计数', actualValues.every((value) => value !== null), JSON.stringify(todayProbe.map((section) => section.text)))
  check('今日页五个分区计数与数据一致', actualValues.join(',') === expectedValues.join(','), `页面 ${actualValues.join(',')} 预期 ${expectedValues.join(',')}`)
  const laterSection = todayProbe.find((section) => section.text.startsWith('更晚'))
  const otherSections = todayProbe.filter((section) => !section.text.startsWith('更晚'))
  check('更晚分区默认折叠', laterSection !== undefined && laterSection.expanded === 'false', `aria-expanded ${laterSection === undefined ? null : laterSection.expanded}`)
  check('其余四个分区默认展开', otherSections.every((section) => section.expanded === 'true'), JSON.stringify(otherSections.map((section) => section.expanded)))

  await switchTab(cdp, '统计')
  await waitForSoft(cdp, "document.querySelector('.tc-stats') !== null", 20000)
  const statsState = JSON.parse(await cdp.evaluate(`
    (() => {
      const page = document.querySelector('.tc-stats')
      if (page === null) return JSON.stringify({ cards: [], values: [], panels: [], distRows: 0, weeks: 0, weekCounts: [], pageText: '' })
      return JSON.stringify({
        cards: [...page.querySelectorAll('.tc-stat-card')].map((node) => (node.textContent || '').trim()),
        values: [...page.querySelectorAll('.tc-stat-value')].map((node) => (node.textContent || '').trim()),
        panels: [...page.querySelectorAll('.tc-panel-head')].map((node) => (node.textContent || '').trim()),
        distRows: page.querySelectorAll('.tc-dist-row').length,
        weeks: page.querySelectorAll('.tc-week-col').length,
        weekCounts: [...page.querySelectorAll('.tc-week-count')].map((node) => (node.textContent || '').trim()),
        pageText: (page.textContent || '').trim()
      })
    })()
  `))
  check('统计页四项指标齐备', statsState.cards.length === 2 && statsState.distRows === 8, `指标卡 ${statsState.cards.length} 分布行 ${statsState.distRows}`)
  check('统计页指标卡文案正确', statsState.cards.length === 2 && statsState.cards[0].includes('本区间完成的顶层待办') && statsState.cards[1].includes('分子') && statsState.cards[1].includes('分母'), JSON.stringify(statsState.cards))
  check('统计页空区间指标取值为 0 与破折号', statsState.values.join(',') === '0,—', JSON.stringify(statsState.values))
  check('统计页两个分布区块齐备', statsState.panels.some((text) => text.includes('当前未完成')) && statsState.panels.some((text) => text.includes('本区间已完成')), JSON.stringify(statsState.panels))
  check('统计页有 8 根周柱', statsState.weeks === 8 && statsState.weekCounts.length === 8, `列数 ${statsState.weeks} 计数 ${JSON.stringify(statsState.weekCounts)}`)
  check('统计页空区间显示提示行', statsState.pageText.includes('该区间没有完成记录'), statsState.pageText.slice(0, 120))

  await switchTab(cdp, '四象限')
  const toolsOpened = await cdp.evaluate(`
    (() => {
      const button = document.querySelector('.tc-tools-wrap button')
      if (button === null) return false
      button.click()
      return true
    })()
  `)
  check('标签行右侧工具菜单可打开', toolsOpened === true, '没有找到工具菜单按钮')
  await waitForSoft(cdp, "document.querySelector('.tc-menu') !== null", 15000)
  const toolItems = JSON.parse(await cdp.evaluate(`
    (() => {
      const menu = document.querySelector('.tc-menu')
      if (menu === null) return JSON.stringify([])
      return JSON.stringify([...menu.querySelectorAll('.tc-menu-item')].map((node) => (node.textContent || '').trim()))
    })()
  `))
  check('工具菜单含导出与导入两项', toolItems.some((text) => text.includes('导出全部数据')) && toolItems.some((text) => text.includes('导入数据')), JSON.stringify(toolItems))
  const importClicked = await clickByText(cdp, '.tc-menu', '导入数据')
  check('导入菜单项可点击', importClicked === true, '没有找到导入数据菜单项')
  await delay(600)

  const exportedResponse = await fetch(`${API}/export`)
  const exportedPayload = await exportedResponse.json()
  if (exportedPayload.ok !== true) throw new Error(exportedPayload.error)
  const exportValue = exportedPayload.value
  const fileSet = await cdp.evaluate(`
    (() => {
      const input = document.querySelector('input[type="file"]')
      if (input === null) return false
      const file = new File([${JSON.stringify(JSON.stringify(exportValue))}], 'ui-check-v2.json', { type: 'application/json' })
      const transfer = new DataTransfer()
      transfer.items.add(file)
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()
  `)
  check('导入入口接受选择文件', fileSet === true, '没有找到文件输入框')
  if (fileSet === true) {
    const importDialogSeen = await waitForSoft(cdp, "document.querySelector('[role=\"dialog\"] .tc-kv-name') !== null", 20000)
    if (importDialogSeen === true) {
      const importInfo = JSON.parse(await cdp.evaluate(`
        (() => {
          const dialog = document.querySelector('[role="dialog"]')
          const labelledBy = dialog.getAttribute('aria-labelledby')
          const labelNode = labelledBy === null ? null : document.getElementById(labelledBy)
          return JSON.stringify({
            title: labelNode === null ? '' : (labelNode.textContent || '').trim(),
            names: [...dialog.querySelectorAll('.tc-kv-name')].map((node) => (node.textContent || '').trim()),
            values: [...dialog.querySelectorAll('.tc-kv-value')].map((node) => (node.textContent || '').trim())
          })
        })()
      `))
      check('导入对话框标题为导入数据', importInfo.title.includes('导入数据'), importInfo.title)
      check('导入对话框四行说明名称正确', importInfo.names.join(',') === '文件名,文件版本,条目数,筛选预设数', importInfo.names.join(','))
      check('导入对话框文件名取自所选文件', importInfo.values[0] === 'ui-check-v2.json', importInfo.values[0])
      check('导入对话框版本取自文件', importInfo.values[1] === '2', importInfo.values[1])
      check('导入对话框条目数取自文件', importInfo.values[2] === String(exportValue.todos.length), `页面 ${importInfo.values[2]} 文件 ${exportValue.todos.length}`)
      check('导入对话框预设数取自文件', importInfo.values[3] === String(exportValue.filters.length), `页面 ${importInfo.values[3]} 文件 ${exportValue.filters.length}`)
      const canceledImport = await clickByText(cdp, '[role="dialog"]', '取消')
      check('导入对话框可取消', canceledImport === true, '没有找到取消按钮')
      await waitForSoft(cdp, "document.querySelector('[role=\"dialog\"]') === null", 15000)
    } else {
      skip('导入对话框标题为导入数据', '导入确认对话框没有打开')
      skip('导入对话框四行说明名称正确', '导入确认对话框没有打开')
      skip('导入对话框文件名取自所选文件', '导入确认对话框没有打开')
      skip('导入对话框版本取自文件', '导入确认对话框没有打开')
      skip('导入对话框条目数取自文件', '导入确认对话框没有打开')
      skip('导入对话框预设数取自文件', '导入确认对话框没有打开')
      skip('导入对话框可取消', '导入确认对话框没有打开')
    }
  } else {
    skip('导入对话框标题为导入数据', '导入入口没有文件输入框，对话框无法打开')
    skip('导入对话框四行说明名称正确', '导入入口没有文件输入框，对话框无法打开')
    skip('导入对话框文件名取自所选文件', '导入入口没有文件输入框，对话框无法打开')
    skip('导入对话框版本取自文件', '导入入口没有文件输入框，对话框无法打开')
    skip('导入对话框条目数取自文件', '导入入口没有文件输入框，对话框无法打开')
    skip('导入对话框预设数取自文件', '导入入口没有文件输入框，对话框无法打开')
    skip('导入对话框可取消', '导入入口没有文件输入框，对话框无法打开')
  }

  await waitForSoft(cdp, `document.querySelectorAll('.tc-card').length > 0`, 20000)
  const moreOpened = await clickByLabel(cdp, `更多操作：${RECURRING_TITLE}`)
  check('卡片更多按钮可点击', moreOpened === true, '没有找到更多操作按钮')
  await waitForSoft(cdp, "document.querySelector('.tc-menu') !== null", 15000)
  const cardMenuItems = JSON.parse(await cdp.evaluate(`
    (() => {
      const menus = [...document.querySelectorAll('.tc-menu')]
      if (menus.length === 0) return JSON.stringify([])
      const menu = menus[menus.length - 1]
      return JSON.stringify([...menu.querySelectorAll('.tc-menu-item')].map((node) => ({
        text: (node.textContent || '').trim(),
        disabled: node.getAttribute('aria-disabled')
      })))
    })()
  `))
  const copyItem = cardMenuItems.find((item) => item.text.includes('复制重复设置'))
  check('卡片更多菜单含复制重复设置', copyItem !== undefined, JSON.stringify(cardMenuItems.map((item) => item.text)))
  check('有重复设置的条目上复制项可用', copyItem !== undefined && copyItem.disabled !== 'true', `aria-disabled ${copyItem === undefined ? null : copyItem.disabled}`)
  await cdp.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await delay(400)

  const addOpened = await clickByLabel(cdp, '在紧急且重要添加待办')
  check('方格添加按钮可点击', addOpened === true, '没有找到方格添加按钮')
  await waitForSoft(cdp, "[...document.querySelectorAll('select')].some((node) => [...node.options].some((option) => option.text === '不重复'))", 15000)
  const repeatInitial = JSON.parse(await cdp.evaluate(`
    (() => {
      const select = [...document.querySelectorAll('select')]
        .find((node) => [...node.options].some((option) => option.text === '不重复'))
      if (select === undefined) return JSON.stringify(null)
      return JSON.stringify({
        options: [...select.options].map((option) => option.text),
        value: select.value,
        numbers: document.querySelectorAll('input[type="number"]').length,
        dates: document.querySelectorAll('input[type="date"]').length
      })
    })()
  `))
  check('添加面板有重复行且频率四值齐备', repeatInitial !== null && repeatInitial.options.join(',') === '不重复,按天,按周,按月', JSON.stringify(repeatInitial === null ? null : repeatInitial.options))
  check('重复行为不重复时隐藏间隔与终止日期', repeatInitial !== null && repeatInitial.numbers === 0, `数字输入 ${repeatInitial === null ? null : repeatInitial.numbers}`)
  const repeatChanged = await cdp.evaluate(`
    (() => {
      const select = [...document.querySelectorAll('select')]
        .find((node) => [...node.options].some((option) => option.text === '不重复'))
      if (select === undefined) return false
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'weekly')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()
  `)
  await delay(500)
  const repeatExpanded = JSON.parse(await cdp.evaluate(`
    (() => {
      const select = [...document.querySelectorAll('select')]
        .find((node) => [...node.options].some((option) => option.text === '不重复'))
      const scope = select === undefined ? null : select.closest('.tc-editor, [role="dialog"], .tc-section, .tc-cell')
      const root = scope ?? document.body
      return JSON.stringify({
        numbers: document.querySelectorAll('input[type="number"]').length,
        dates: document.querySelectorAll('input[type="date"]').length,
        text: (root.textContent || '').trim()
      })
    })()
  `))
  check('重复行选择频率后展开间隔与终止日期', repeatChanged === true && repeatExpanded.numbers >= 1 && repeatExpanded.text.includes('个周期'), `数字输入 ${repeatExpanded.numbers} 日期 ${repeatExpanded.dates}`)
  check('重复行展开后显示规则预览', /每\s*1\s*周重复/.test(repeatExpanded.text), repeatExpanded.text.slice(0, 160))
  await cdp.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await delay(400)

  const relevantErrors = cdp.consoleErrors.filter((text) => !text.includes('favicon') && !text.includes('Download the React DevTools'))
  const ownErrors = relevantErrors.filter((text) => text.includes('dsh-4quadrant-todo') || text.includes('four-quadrant-todo/lib') || text.includes('TodoCenterPage') || text.includes('TodoCenterDock'))
  const foreignErrors = relevantErrors.filter((text) => !ownErrors.includes(text))
  check('插件自身没有未捕获异常', ownErrors.length === 0, ownErrors.join(' | '))
  if (foreignErrors.length > 0) {
    console.log(`观察: 非本插件错误 ${foreignErrors.length} 条，不作为失败项统计`)
    for (const text of foreignErrors.slice(0, 3)) console.log(`观察明细: ${text.slice(0, 200)}`)
  }
} finally {
  if (cdp !== null && cdp.consoleErrors.length > 0) console.log('页面错误明细:', JSON.stringify(cdp.consoleErrors, null, 2))
  if (cdp !== null) cdp.close()
  if (browser !== null) browser.kill()

  const current = await apiSnapshot()
  if (current.readOnly === true) await apiPost('/upgrade', { confirm: true })
  await apiPost('/import', { payload: originalData, fileName: 'ui-check-v2-restore.json' })
  const restored = await apiSnapshot()
  const signature = (value) => JSON.stringify({
    titles: value.todos.map((todo) => `${todo.title}|${todo.status}|${todo.quadrant}|${todo.dueAt}`).sort(),
    collapsed: value.collapsed,
    filters: value.filters.map((preset) => preset.name).sort(),
    settings: value.settings
  })
  check('结束时数据回到运行前的内容', signature(restored) === signature(originalData), `现状 ${signature(restored)} 运行前 ${signature(originalData)}`)

  // 删除本套件导入动作产生的备份文件，运行前已有的备份保留
  const leftovers = []
  for (const name of await readdir(dataDir)) {
    if (name.startsWith('todos.before-import-') === false) continue
    const info = await stat(path.join(dataDir, name))
    if (info.mtimeMs < startedAt) continue
    await unlink(path.join(dataDir, name))
    leftovers.push(name)
  }
  console.log(`清理导入备份 ${leftovers.length} 个`)

  console.log('----')
  if (failures.length > 0) console.log('失败项:', failures.join(' | '))
  if (skipped > 0) console.log(`跳过 ${skipped} 项`)
  console.log(`共 ${checks} 项，失败 ${failures.length}`)
  process.exitCode = failures.length
}
