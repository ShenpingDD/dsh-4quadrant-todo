// 布局度量套件：按 docs/review/ui-defects-2.0.md 第 7 节的 L1 至 L8 在真实页面上量取几何与计算样式
// 数据只通过真实接口创建与删除，结束时删除本套件自己创建的条目，不改动用户已有数据
// 用法：node tests/ui-layout.mjs

import { setTimeout as delay } from 'node:timers/promises'
import {
  ORIGIN,
  PORT,
  apiPost,
  apiSnapshot,
  clickByLabel,
  launchAndConnect,
  readServerUrl,
  waitFor
} from './cdp-harness.mjs'

const OVERDUE_TITLE = '布局验证 逾期'
const VIEWPORT_HEIGHT = 1080

const failures = []
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) console.log(`PASS ${label}`)
  else {
    console.log(`FAIL ${label} -> ${detail}`)
    failures.push(label)
  }
}

function parsePx(text) {
  const match = /^(-?[\d.]+)px$/.exec(String(text).trim())
  return match === null ? null : Number(match[1])
}

function parseDurationMs(text) {
  const match = /^(-?[\d.]+)(ms|s)$/.exec(String(text).trim())
  if (match === null) return null
  const value = Number(match[1])
  return match[2] === 's' ? value * 1000 : value
}

function durationsAllZero(text) {
  const parts = String(text).split(',').map((part) => part.trim()).filter((part) => part !== '')
  return parts.length > 0 && parts.every((part) => {
    const value = parseDurationMs(part)
    return value !== null && value === 0
  })
}

async function createTodo(body) {
  const value = await apiPost('/create', {
    description: '',
    dueAt: null,
    workspaceId: null,
    source: { kind: 'manual' },
    ...body
  })
  createdIds.push(value.focusId)
  return value.focusId
}

async function useViewport(cdp, width) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: VIEWPORT_HEIGHT,
    deviceScaleFactor: 1,
    mobile: false
  })
  await delay(500)
  const actual = await cdp.evaluate('window.innerWidth')
  if (actual !== width) throw new Error(`视口宽度未生效: 期望 ${width}，实际 ${actual}`)
}

function normalizeColorExpression() {
  return `
    (() => {
      const parse = (text) => {
        const rgb = /^rgba?\\(([^)]+)\\)$/.exec(text)
        if (rgb !== null) {
          const parts = rgb[1].split(/[\\s,/]+/).filter((part) => part !== '').map(Number)
          if (parts.length >= 3 && parts.slice(0, 3).every((value) => Number.isFinite(value))) return parts.slice(0, 3)
          return null
        }
        const srgb = /^color\\(srgb ([^)]+)\\)$/.exec(text)
        if (srgb !== null) {
          const parts = srgb[1].split(/[\\s/]+/).filter((part) => part !== '').map(Number)
          if (parts.length >= 3 && parts.slice(0, 3).every((value) => Number.isFinite(value))) {
            return parts.slice(0, 3).map((value) => Math.round(value * 255))
          }
          return null
        }
        return null
      }
      window.__tcParseColor = parse
      window.__tcSameColor = (left, right, tolerance) => {
        const one = parse(left)
        const two = parse(right)
        if (one === null || two === null) return left === right
        return one.every((value, index) => Math.abs(value - two[index]) <= (tolerance === undefined ? 2 : tolerance))
      }
      return true
    })()
  `
}

// 在方格内部放一个探针，量出指定混色比例的最终颜色，量完删除探针
function probeMixScript(ratio, base) {
  return `
    (() => {
      const cells = [...document.querySelectorAll('.tc-cell')]
      const result = {}
      for (const cell of cells) {
        const quadrant = cell.getAttribute('data-tc-quadrant')
        const probe = document.createElement('span')
        probe.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none;visibility:hidden;background:color-mix(in srgb, var(--tc-quadrant) ${ratio}%, ${base})'
        cell.appendChild(probe)
        result[quadrant] = getComputedStyle(probe).backgroundColor
        probe.remove()
      }
      return JSON.stringify(result)
    })()
  `
}

const MEASURE_QUADRANTS = `
  (() => {
    const rect = (node) => {
      const box = node.getBoundingClientRect()
      return {
        left: Math.round(box.left),
        top: Math.round(box.top),
        width: Math.round(box.width),
        height: Math.round(box.height)
      }
    }
    const styleOf = (node) => getComputedStyle(node)
    const page = document.querySelector('.tc-page')
    const shell = document.querySelector('.tc-shell')
    const grid = document.querySelector('.tc-grid')
    const gridStyle = styleOf(grid)
    const cells = [...document.querySelectorAll('.tc-cell')].map((cell) => {
      const head = cell.querySelector('.tc-cell-head')
      const body = cell.querySelector('.tc-cell-body')
      const bodyStyle = body === null ? null : styleOf(body)
      const cellStyle = styleOf(cell)
      const cards = [...cell.querySelectorAll('.tc-card')].map((card) => {
        const titleNode = card.querySelector('.tc-card-title')
        const cardStyle = styleOf(card)
        return {
          title: titleNode === null ? '' : (titleNode.textContent || '').trim(),
          rect: rect(card),
          borderLeftWidth: cardStyle.borderLeftWidth,
          borderLeftColor: cardStyle.borderLeftColor,
          borderTopWidth: cardStyle.borderTopWidth,
          borderTopColor: cardStyle.borderTopColor,
          transitionDuration: cardStyle.transitionDuration,
          text: (card.textContent || '').trim(),
          badgeTexts: [...card.querySelectorAll('*')]
            .map((node) => (node.textContent || '').trim())
            .filter((text) => text !== '' && text.length <= 24 && /逾期/.test(text))
        }
      })
      return {
        quadrant: cell.getAttribute('data-tc-quadrant'),
        rect: rect(cell),
        headBackground: head === null ? null : styleOf(head).backgroundColor,
        leftBorderWidth: cellStyle.borderLeftWidth,
        leftBorderColor: cellStyle.borderLeftColor,
        background: cellStyle.backgroundColor,
        bodyDisplay: bodyStyle === null ? null : bodyStyle.display,
        bodyGridColumns: bodyStyle === null ? null : bodyStyle.gridTemplateColumns,
        bodyColumnCount: bodyStyle === null ? null : bodyStyle.columnCount,
        bodyGap: bodyStyle === null ? null : bodyStyle.gap,
        cards
      }
    })
    const shellStyle = styleOf(shell)
    return JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      page: { ...rect(page), scrollHeight: page.scrollHeight, clientHeight: page.clientHeight },
      shell: {
        ...rect(shell),
        clientWidth: shell.clientWidth,
        paddingLeft: shellStyle.paddingLeft,
        paddingRight: shellStyle.paddingRight,
        maxWidth: shellStyle.maxWidth
      },
      grid: {
        ...rect(grid),
        display: gridStyle.display,
        gridTemplateColumns: gridStyle.gridTemplateColumns,
        gridTemplateRows: gridStyle.gridTemplateRows,
        flexDirection: gridStyle.flexDirection,
        gap: gridStyle.gap
      },
      cells
    })
  })()
`

const MEASURE_COMPLETED = `
  (() => {
    const rect = (node) => {
      const box = node.getBoundingClientRect()
      return {
        left: Math.round(box.left),
        top: Math.round(box.top),
        width: Math.round(box.width),
        height: Math.round(box.height)
      }
    }
    const bar = document.querySelector('.tc-filterbar')
    const head = document.querySelector('.tc-list-head')
    const headStyle = head === null ? null : getComputedStyle(head)
    const rows = [...document.querySelectorAll('.tc-list-row')].map((node) => rect(node))
    const rangeSelects = [...document.querySelectorAll('select[aria-label="完成时间范围"]')]
    const rangeGroups = [...document.querySelectorAll('[role="group"][aria-label="完成时间范围"]')]
    const rangeButtons = [...document.querySelectorAll('.tc-seg-btn')]
    return JSON.stringify({
      filterbar: bar === null
        ? null
        : {
          scrollWidth: bar.scrollWidth,
          clientWidth: bar.clientWidth,
          overflowX: getComputedStyle(bar).overflowX,
          flexWrap: getComputedStyle(bar).flexWrap,
          rect: rect(bar)
        },
      listHead: head === null
        ? null
        : {
          rect: rect(head),
          display: headStyle.display,
          gridTemplateColumns: headStyle.gridTemplateColumns,
          minHeight: headStyle.minHeight
        },
      rows,
      rangeControlCount: rangeSelects.length + rangeButtons.length,
      rangeGroups: rangeGroups.length,
      rangeButtons: rangeButtons.map((node) => (node.textContent || '').trim())
    })
  })()
`

async function reopenPanel(cdp) {
  console.log('观察: 页面在测量期间被卸载，重新加载页面并打开面板')
  await cdp.send('Page.reload')
  await waitFor(cdp, "document.querySelector('.tc-icon-wrap') !== null", '侧栏入口出现', 60000)
  const opened = await clickByLabel(cdp, '待办中心')
  if (opened !== true) throw new Error('侧栏入口不可点击')
  await waitFor(cdp, "document.querySelector('.tc-grid') !== null", '四象限栅格出现', 30000)
  await waitFor(
    cdp,
    `[...document.querySelectorAll('.tc-card-title')].some((node) => (node.textContent || '').includes(${JSON.stringify(OVERDUE_TITLE)}))`,
    '四象限卡片渲染完成',
    30000
  )
  await cdp.evaluate(normalizeColorExpression())
}

async function ensurePanel(cdp) {
  const alive = await cdp.evaluate("document.querySelector('.tc-page') !== null")
  if (alive !== true) await reopenPanel(cdp)
}

async function collectQuadrants(cdp) {
  await ensurePanel(cdp)
  const raw = await cdp.evaluate(MEASURE_QUADRANTS)
  const measured = JSON.parse(raw)
  const mixedCard = JSON.parse(await cdp.evaluate(probeMixScript(56, 'var(--dsw-alias-label-primary)')))
  return { measured, mixedCard }
}

async function switchTab(cdp, name) {
  await ensurePanel(cdp)
  const clicked = await cdp.evaluate(`
    (() => {
      const tab = [...document.querySelectorAll('[role="tab"]')]
        .find((node) => (node.textContent || '').trim() === ${JSON.stringify(name)})
      if (tab === undefined) return false
      tab.click()
      return true
    })()
  `)
  if (clicked !== true) throw new Error(`页签不可点击: ${name}`)
  await delay(500)
}

const createdIds = []
let browser = null
let cdp = null

const before = await apiSnapshot()
if (before.dataVersion === undefined) {
  console.log('Host 2.0 路由未就绪: GET /snapshot 缺少 dataVersion，先重启 3080 再运行本套件')
  process.exit(2)
}
if (before.readOnly === true) {
  console.log('数据文件为版本 1 只读态，布局套件需要写路由造测量数据，先在页面完成升级再运行')
  process.exit(2)
}

let debuggerBusy = false
for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    debuggerBusy = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok
  } catch {
    debuggerBusy = false
  }
  if (debuggerBusy === false) break
  await delay(500)
}
if (debuggerBusy === true) {
  console.log(`调试端口 ${PORT} 已被占用，可能上次中断留下无头浏览器，先结束它再运行本套件`)
  process.exit(2)
}

const staleIds = before.todos.filter((todo) => String(todo.title).startsWith('布局验证')).map((todo) => todo.id)
let currentTodos = before.todos
if (staleIds.length > 0) {
  await apiPost('/remove', { ids: staleIds })
  console.log(`观察: 清掉上次中断留下的验证条目 ${staleIds.length} 条`)
  currentTodos = (await apiSnapshot()).todos
}

const beforeIds = currentTodos.map((todo) => todo.id)

const now = Date.now()
const overdueDue = new Date(now - 2 * 86400000).toISOString()
const tomorrow = new Date(now + 86400000)
tomorrow.setHours(10, 0, 0, 0)

try {
  await createTodo({ title: OVERDUE_TITLE, quadrant: 'urgent-important', dueAt: overdueDue })
  await createTodo({ title: '布局验证 紧急重要二', quadrant: 'urgent-important', dueAt: tomorrow.toISOString() })
  await createTodo({ title: '布局验证 紧急不重要', quadrant: 'urgent-not-important', dueAt: tomorrow.toISOString() })
  await createTodo({ title: '布局验证 重要不紧急', quadrant: 'not-urgent-important', dueAt: tomorrow.toISOString() })
  await createTodo({ title: '布局验证 不紧急不重要', quadrant: 'not-urgent-not-important', dueAt: tomorrow.toISOString() })

  for (const title of ['布局验证 已完成一', '布局验证 已完成二', '布局验证 已完成三']) {
    const id = await createTodo({ title, quadrant: 'urgent-important', dueAt: tomorrow.toISOString() })
    await apiPost('/complete', { ids: [id], includeChildren: false })
  }

  const launched = await launchAndConnect(await readServerUrl())
  browser = launched.browser
  cdp = launched.cdp

  const responsive = await Promise.race([
    cdp.evaluate('document.readyState !== undefined'),
    delay(15000).then(() => 'timeout')
  ])
  if (responsive === 'timeout') throw new Error('页面在 15 秒内没有响应，调试端口可能被陈旧浏览器实例占用')

  await waitFor(cdp, "document.querySelector('.tc-icon-wrap') !== null", '侧栏入口出现', 60000)
  await useViewport(cdp, 1920)
  const opened = await clickByLabel(cdp, '待办中心')
  if (opened !== true) throw new Error('侧栏入口不可点击')
  await waitFor(cdp, "document.querySelector('.tc-grid') !== null", '四象限栅格出现', 30000)
  await waitFor(
    cdp,
    `[...document.querySelectorAll('.tc-card-title')].some((node) => (node.textContent || '').includes(${JSON.stringify(OVERDUE_TITLE)}))`,
    '四象限卡片渲染完成',
    30000
  )
  await cdp.evaluate(normalizeColorExpression())

  // 显式声明常规动态效果偏好，避免运行环境的系统设置把减少动态效果带进基线测量
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
  })
  await delay(300)
  const prefersReduced = await cdp.evaluate("window.matchMedia('(prefers-reduced-motion: reduce)').matches")
  console.log(`观察: 常规偏好下 matchMedia 减少动态效果 ${prefersReduced}`)

  // ---------- L1 内容列铺满画布 ----------
  const at1920 = await collectQuadrants(cdp)
  const shell = at1920.measured.shell
  const page = at1920.measured.page
  const paddingLeft = parsePx(shell.paddingLeft)
  const paddingRight = parsePx(shell.paddingRight)
  const contentWidth = shell.clientWidth - paddingLeft - paddingRight
  const expectedWidth = page.width - paddingLeft - paddingRight - 4
  console.log(`观察: L1 内容列 ${contentWidth}，画布 ${page.width}，内边距 ${paddingLeft}/${paddingRight}，期望不小于 ${expectedWidth}，max-width ${shell.maxWidth}，shell 左 ${shell.left} 宽 ${shell.width}`)
  check(
    'L1 1920 视口内容列铺满画布',
    contentWidth >= expectedWidth && shell.maxWidth === 'none',
    `内容列 ${contentWidth}，画布 ${page.width}，内边距 ${paddingLeft}/${paddingRight}，期望不小于 ${expectedWidth}，max-width ${shell.maxWidth}，shell 左 ${shell.left} 宽 ${shell.width}`
  )

  // ---------- L2 四格头部背景与左缘颜色互不相同 ----------
  const heads = at1920.measured.cells.map((cell) => cell.headBackground)
  const edges = at1920.measured.cells.map((cell) => cell.leftBorderColor)
  const distinctHeads = new Set(heads.map((text) => text ?? '')).size
  const distinctEdges = new Set(edges.map((text) => text ?? '')).size
  console.log(`观察: L2 头部背景 ${JSON.stringify(heads)}`)
  console.log(`观察: L2 左缘颜色 ${JSON.stringify(edges)}`)
  check(
    'L2 四格头部背景为四个不同取值',
    at1920.measured.cells.length === 4 && distinctHeads === 4,
    `头部背景 ${JSON.stringify(heads)}，不同取值 ${distinctHeads}`
  )
  check(
    'L2 四格左缘颜色为四个不同取值',
    at1920.measured.cells.length === 4 && distinctEdges === 4,
    `左缘颜色 ${JSON.stringify(edges)}，不同取值 ${distinctEdges}`
  )

  // ---------- L3 左缘宽度与卡片左缘色 ----------
  const cellEdgeWidths = at1920.measured.cells.map((cell) => cell.leftBorderWidth)
  const expectedCardEdge = at1920.mixedCard
  const cardEdgeProblems = []
  for (const cell of at1920.measured.cells) {
    for (const card of cell.cards) {
      if (card.title === OVERDUE_TITLE) continue
      const expected = expectedCardEdge[cell.quadrant]
      const matchesExpected = await cdp.evaluate(`window.__tcSameColor(${JSON.stringify(card.borderLeftColor)}, ${JSON.stringify(expected)})`)
      const matchesCell = await cdp.evaluate(`window.__tcSameColor(${JSON.stringify(card.borderLeftColor)}, ${JSON.stringify(cell.leftBorderColor)})`)
      const widthOk = Math.abs(parsePx(card.borderLeftWidth) - 3) <= 0.6
      if (!(widthOk && (matchesExpected || matchesCell))) {
        cardEdgeProblems.push({
          quadrant: cell.quadrant,
          title: card.title,
          width: card.borderLeftWidth,
          color: card.borderLeftColor,
          expected,
          cellEdge: cell.leftBorderColor
        })
      }
    }
  }
  check(
    'L3 方格左缘宽 4 像素且卡片左缘 3 像素',
    cellEdgeWidths.every((text) => Math.abs(parsePx(text) - 4) <= 0.4),
    `方格左缘宽度 ${JSON.stringify(cellEdgeWidths)}`
  )
  check(
    'L3 卡片左缘色与配色规则一致',
    cardEdgeProblems.length === 0,
    JSON.stringify(cardEdgeProblems)
  )

  // ---------- L8 逾期卡片红色描边与徽标 ----------
  const overdueCell = at1920.measured.cells.find((cell) => cell.quadrant === 'urgent-important')
  const overdueCard = overdueCell === undefined
    ? undefined
    : overdueCell.cards.find((card) => card.title === OVERDUE_TITLE)
  const errorColor = await cdp.evaluate(`
    (() => {
      const probe = document.createElement('span')
      probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;background:var(--dsw-alias-state-error-primary)'
      document.querySelector('.tc-page').appendChild(probe)
      const value = getComputedStyle(probe).backgroundColor
      probe.remove()
      return value
    })()
  `)
  const overdueBorderMatches = overdueCard === undefined
    ? false
    : await cdp.evaluate(`window.__tcSameColor(${JSON.stringify(overdueCard.borderTopColor)}, ${JSON.stringify(errorColor)})`)
  const overdueBorderWidth = overdueCard === undefined ? null : overdueCard.borderTopWidth
  const badgeText = overdueCard === undefined
    ? null
    : overdueCard.badgeTexts.find((text) => /逾期\s*\d+\s*天/.test(text)) ?? null
  check(
    'L8 逾期卡片有 1 像素红色描边',
    overdueCard !== undefined && overdueBorderMatches === true && Math.abs(parsePx(overdueBorderWidth) - 1) <= 0.3,
    `宽度 ${overdueBorderWidth} 颜色 ${overdueCard === undefined ? null : overdueCard.borderTopColor} 期望 ${errorColor}`
  )
  check(
    'L8 逾期卡片有逾期天数徽标',
    badgeText !== null,
    `候选文案 ${JSON.stringify(overdueCard === undefined ? null : overdueCard.badgeTexts)} 卡片文本 ${JSON.stringify(overdueCard === undefined ? null : overdueCard.text.slice(0, 80))}`
  )

  // ---------- L7 过渡时长 ----------
  const cardDurations = at1920.measured.cells.flatMap((cell) => cell.cards.map((card) => card.transitionDuration))
  const positiveDuration = cardDurations.some((text) => String(text).split(',').some((part) => (parseDurationMs(part.trim()) ?? 0) > 0))
  console.log(`观察: L7 卡片过渡时长 ${JSON.stringify(cardDurations)}`)
  check(
    'L7 卡片过渡时长非 0',
    positiveDuration === true,
    `transitionDuration ${JSON.stringify(cardDurations)}`
  )

  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  })
  await delay(400)
  const reducedCards = JSON.parse(await cdp.evaluate(`
    (() => {
      return JSON.stringify([...document.querySelectorAll('.tc-card')].map((node) => {
        const style = getComputedStyle(node)
        return { transitionDuration: style.transitionDuration, animationDuration: style.animationDuration }
      }))
    })()
  `))
  const reducedZero = reducedCards.every((card) => durationsAllZero(card.transitionDuration) && durationsAllZero(card.animationDuration))
  check(
    'L7 减少动态效果下过渡与动画归零',
    reducedZero === true,
    JSON.stringify(reducedCards.slice(0, 4))
  )
  await cdp.send('Emulation.setEmulatedMedia', { features: [] })
  await delay(300)

  // ---------- L4 断点行为 ----------
  await useViewport(cdp, 1720)
  const at1720 = await collectQuadrants(cdp)
  const stackProblems = []
  for (const cell of at1720.measured.cells) {
    const cardCount = cell.cards.length
    if (cardCount < 2) continue
    const lefts = cell.cards.map((card) => card.rect.left)
    const tops = cell.cards.map((card) => card.rect.top)
    let stacked = true
    for (let index = 0; index + 1 < cardCount; index += 1) {
      if (tops[index + 1] <= tops[index]) stacked = false
    }
    const sameLeft = new Set(lefts).size === 1
    if (!(stacked && sameLeft)) {
      stackProblems.push({
        quadrant: cell.quadrant,
        display: cell.bodyDisplay,
        lefts,
        tops
      })
    }
  }
  check(
    'L4 1720 视口下每格卡片逐行向下排成一列',
    stackProblems.length === 0,
    JSON.stringify(stackProblems)
  )

  const gridTracks = (measured) => (measured.grid.display === 'grid'
    ? measured.grid.gridTemplateColumns.split(/\s+(?![^(]*\))/).filter((part) => part !== '')
    : [])

  await useViewport(cdp, 900)
  const at900 = await collectQuadrants(cdp)
  check(
    'L4 900 视口下保持两列',
    gridTracks(at900.measured).length === 2,
    `列 ${JSON.stringify(at900.measured.grid.gridTemplateColumns)} 内容列 ${at900.measured.shell.width}`
  )

  await useViewport(cdp, 620)
  const atNarrow = await collectQuadrants(cdp)
  const singleColumn = atNarrow.measured.grid.display === 'grid'
    ? gridTracks(atNarrow.measured).length === 1
    : atNarrow.measured.grid.display === 'flex' && atNarrow.measured.grid.flexDirection === 'column'
  const shortCells = atNarrow.measured.cells.filter((cell) => cell.rect.height < 0.4 * atNarrow.measured.viewport.height - 1)
  check(
    'L4 内容宽度不足时改纵向单列',
    singleColumn === true && shortCells.length === 0,
    `列 ${JSON.stringify(atNarrow.measured.grid.gridTemplateColumns)} 方格高 ${JSON.stringify(atNarrow.measured.cells.map((cell) => cell.rect.height))} 视口高 ${atNarrow.measured.viewport.height}`
  )
  const scrollObservation = JSON.parse(await cdp.evaluate(`
    (() => {
      const metrics = (selector) => {
        const node = document.querySelector(selector)
        if (node === null) return null
        const style = getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return {
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          scrollTop: node.scrollTop,
          overflowY: style.overflowY,
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          height: Math.round(rect.height)
        }
      }
      const cells = [...document.querySelectorAll('.tc-cell')]
      const lastCell = cells[cells.length - 1]
      return JSON.stringify({
        page: metrics('.tc-page'),
        shell: metrics('.tc-shell'),
        tabpanel: metrics('.tc-tabpanel'),
        grid: metrics('.tc-grid'),
        lastCellBottom: lastCell === undefined ? null : Math.round(lastCell.getBoundingClientRect().bottom),
        viewportHeight: window.innerHeight
      })
    })()
  `))
  console.log(`观察: 680 视口滚动结构 ${JSON.stringify(scrollObservation)}`)
  await useViewport(cdp, 1920)

  // ---------- 头部结构观察：供同步其它套件的选择器 ----------
  const headObservation = JSON.parse(await cdp.evaluate(`
    (() => {
      const panels = [...document.querySelectorAll('.tc-tabpanel')]
      return JSON.stringify({
        panelCount: panels.length,
        panelKeys: panels.map((node) => node.getAttribute('data-tc-tab')),
        cellHeads: [...document.querySelectorAll('.tc-cell')].map((cell) => ({
          quadrant: cell.getAttribute('data-tc-quadrant'),
          text: ((cell.querySelector('.tc-cell-head') || {}).textContent || '').trim()
        }))
      })
    })()
  `))
  console.log(`观察: 方格头部 ${JSON.stringify(headObservation.cellHeads)}`)
  console.log(`观察: 页签容器 ${headObservation.panelCount} 个，键 ${JSON.stringify(headObservation.panelKeys)}`)

  // ---------- L5 与 L6 已完成页 ----------
  await switchTab(cdp, '已完成')
  await waitFor(cdp, "document.querySelector('.tc-list-head') !== null", '已完成页头部出现', 20000)
  await delay(400)
  const completedState = JSON.parse(await cdp.evaluate(MEASURE_COMPLETED))
  const sortedRows = [...completedState.rows].sort((left, right) => left.top - right.top)
  const rowGaps = []
  for (let index = 1; index < sortedRows.length; index += 1) {
    rowGaps.push({
      gap: sortedRows[index].top - sortedRows[index - 1].top,
      previousHeight: sortedRows[index - 1].height
    })
  }
  const firstThreeGaps = rowGaps.slice(0, 2)
  const layoutRows = firstThreeGaps.length === 2 && firstThreeGaps.every((entry) => Math.abs(entry.gap - entry.previousHeight) <= 1)
  console.log(`观察: L5 行数 ${sortedRows.length}，顶边 ${JSON.stringify(sortedRows.map((row) => row.top))}，行高 ${JSON.stringify(sortedRows.map((row) => row.height))}，差值 ${JSON.stringify(rowGaps)}`)
  check(
    'L5 已完成页相邻行顶边差等于行高',
    sortedRows.length >= 3 && layoutRows === true,
    `行数 ${sortedRows.length}，顶边 ${JSON.stringify(sortedRows.map((row) => row.top))}，行高 ${JSON.stringify(sortedRows.map((row) => row.height))}，差值 ${JSON.stringify(rowGaps)}`
  )
  check(
    'L5 已完成行高不小于 36 像素',
    sortedRows.length >= 3 && sortedRows.slice(0, 3).every((row) => row.height >= 35),
    `行高 ${JSON.stringify(sortedRows.map((row) => row.height))}`
  )

  const filterbar = completedState.filterbar
  console.log(`观察: L6 筛选条 scrollWidth ${filterbar === null ? null : filterbar.scrollWidth} clientWidth ${filterbar === null ? null : filterbar.clientWidth}，完成时间范围控件 ${completedState.rangeControlCount} 个，分段按钮 ${JSON.stringify(completedState.rangeButtons)}`)
  check(
    'L6 已完成页筛选条不溢出',
    filterbar !== null && filterbar.scrollWidth <= filterbar.clientWidth + 1,
    `scrollWidth ${filterbar === null ? null : filterbar.scrollWidth} clientWidth ${filterbar === null ? null : filterbar.clientWidth}`
  )
  check(
    'L6 完成时间范围控件数量为 1',
    completedState.rangeControlCount === 1,
    `控件数 ${completedState.rangeControlCount}，分段按钮 ${JSON.stringify(completedState.rangeButtons)}，分组 ${completedState.rangeGroups}`
  )
  console.log(`观察: 已完成页头部 ${JSON.stringify(completedState.listHead)}`)

  // ---------- 插件自身异常 ----------
  const relevantErrors = cdp.consoleErrors.filter((text) => !text.includes('favicon') && !text.includes('Download the React DevTools') && !text.includes('Sidebar Session opening failed'))
  const ownErrors = relevantErrors.filter((text) => text.includes('dsh-4quadrant-todo') || text.includes('four-quadrant-todo/lib') || text.includes('TodoCenterPage') || text.includes('TodoCenterDock'))
  const foreignErrors = relevantErrors.filter((text) => !ownErrors.includes(text))
  check('插件自身没有未捕获异常', ownErrors.length === 0, ownErrors.join(' | '))
  if (foreignErrors.length > 0) {
    console.log(`观察: 非本插件错误 ${foreignErrors.length} 条，不作为失败项统计`)
    for (const text of foreignErrors.slice(0, 3)) console.log(`观察明细: ${text.slice(0, 200)}`)
  }
} finally {
  if (cdp !== null && cdp.consoleErrors.length > 0) {
    console.log(`页面错误明细 ${cdp.consoleErrors.length} 条:`)
    for (const text of cdp.consoleErrors.slice(0, 5)) console.log(`  ${String(text).slice(0, 400)}`)
  }
  if (cdp !== null) {
    await cdp.send('Browser.close').catch(() => undefined)
    cdp.close()
  }
  if (browser !== null) browser.kill()

  if (createdIds.length > 0) {
    await apiPost('/remove', { ids: createdIds })
  }
  const after = await apiSnapshot()
  const afterIds = after.todos.map((todo) => todo.id)
  const keptExisting = beforeIds.every((id) => afterIds.includes(id))
  const removedOwn = createdIds.every((id) => !afterIds.includes(id))
  check(
    '结束时删除本套件创建的条目并保留已有条目',
    keptExisting === true && removedOwn === true,
    `已有条目保留 ${keptExisting}，自建条目清空 ${removedOwn}，剩余 ${JSON.stringify(afterIds)}`
  )

  console.log('----')
  if (failures.length > 0) console.log('失败项:', failures.join(' | '))
  console.log(`共 ${checks} 项，失败 ${failures.length} 项`)
  process.exitCode = failures.length
}
