import { setTimeout as delay } from 'node:timers/promises'
import { readdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import {
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

const QUADRANT_IDS = ['urgent-important', 'not-urgent-important', 'urgent-not-important', 'not-urgent-not-important']

const appUrl = await readServerUrl()

// 运行前的完整数据，收尾按它恢复；导入备份按开始时刻筛选后删除
const originalData = await apiGet('/export')
await saveBackup(originalData, 'ui-check-v11')
const startedAt = Date.now()

const leftovers = await apiSnapshot()
for (const item of leftovers.todos) {
  if (item.parentId === null) await apiPost('/remove', { ids: [item.id] })
}
for (const quadrant of QUADRANT_IDS) {
  await apiPost('/setCollapsed', { scopeKey: 'all', quadrant, collapsed: false })
}

const created = await apiPost('/create', {
  title: '角标与卡片验证任务',
  description: '用于验证 v1.1 的卡片与角标',
  dueAt: null,
  quadrant: 'urgent-important',
  workspaceId: null,
  source: { kind: 'manual' }
})
const todoId = created.focusId

const iconProbe = `
  (() => {
    const styleCount = document.querySelectorAll('style[data-plugin="dsh-4quadrant-todo"]').length
    const wrap = document.querySelector('.tc-icon-wrap')
    const badge = document.querySelector('.tc-badge')
    const wrapStyle = wrap === null ? null : getComputedStyle(wrap)
    const badgeStyle = badge === null ? null : getComputedStyle(badge)
    const badgeRect = badge === null ? null : badge.getBoundingClientRect()
    const trigat = [...document.querySelectorAll('button,[role="button"]')]
      .find((node) => node.getAttribute('aria-label') === '待办中心')
    return JSON.stringify({
      styleCount,
      wrapPosition: wrapStyle === null ? null : wrapStyle.position,
      badgePosition: badgeStyle === null ? null : badgeStyle.position,
      badgeWidth: badgeRect === null ? null : Math.round(badgeRect.width),
      badgeHeight: badgeRect === null ? null : Math.round(badgeRect.height),
      badgeTop: badgeStyle === null ? null : badgeStyle.top,
      badgeRight: badgeStyle === null ? null : badgeStyle.right,
      triggerTextHasStyle: trigat === undefined ? null : (trigat.textContent || '').includes('.tc-page{')
    })
  })()
`

const { browser, cdp } = await launchAndConnect(appUrl)
let exitCode = 0
try {
  await waitFor(cdp, "document.querySelector('.tc-icon-wrap') !== null", '侧栏图标出现', 40000)
  await waitFor(cdp, "document.querySelector('.tc-badge') !== null", '侧栏角标出现', 40000)
  await delay(1200)

  const closed = JSON.parse(await cdp.evaluate(iconProbe))
  check('插件启用期间样式表恰好 1 个', closed.styleCount === 1, `数量 ${closed.styleCount}`)
  check('面板关闭时图标容器为相对定位', closed.wrapPosition === 'relative', `position ${closed.wrapPosition}`)
  check('面板关闭时角标为绝对定位', closed.badgePosition === 'absolute', `position ${closed.badgePosition}`)
  check('面板关闭时角标贴右上角', closed.badgeTop !== null && closed.badgeTop.startsWith('-') && closed.badgeRight !== null && closed.badgeRight.startsWith('-'), `top ${closed.badgeTop} right ${closed.badgeRight}`)
  check('角标尺寸不小于 15 像素', closed.badgeWidth >= 15 && closed.badgeHeight >= 15, `${closed.badgeWidth}×${closed.badgeHeight}`)
  check('侧栏按钮的可读文本不含样式文本', closed.triggerTextHasStyle === false, '按钮文本混入样式内容')

  const opened = await clickByLabel(cdp, '待办中心')
  check('侧栏图标可点击打开面板', opened === true, '没有找到侧栏入口')
  await waitFor(cdp, "document.querySelector('.tc-page') !== null", '面板打开', 20000)
  await waitFor(cdp, "document.querySelector('.tc-card') !== null", '卡片渲染', 20000)
  const openState = JSON.parse(await cdp.evaluate(iconProbe))
  check('面板打开时样式表仍为 1 个', openState.styleCount === 1, `数量 ${openState.styleCount}`)
  check('面板开关前后角标位置一致', openState.badgePosition === closed.badgePosition && openState.badgeTop === closed.badgeTop && openState.badgeRight === closed.badgeRight, `关闭 ${closed.badgePosition}/${closed.badgeTop}/${closed.badgeRight} 打开 ${openState.badgePosition}/${openState.badgeTop}/${openState.badgeRight}`)
  check('面板开关前后角标尺寸一致', openState.badgeWidth === closed.badgeWidth && openState.badgeHeight === closed.badgeHeight, `关闭 ${closed.badgeWidth}×${closed.badgeHeight} 打开 ${openState.badgeWidth}×${openState.badgeHeight}`)

  const cells = JSON.parse(await cdp.evaluate(`
    (() => {
      const nodes = [...document.querySelectorAll('.tc-cell')]
      return JSON.stringify(nodes.map((node) => ({
        quadrant: node.getAttribute('data-tc-quadrant'),
        background: getComputedStyle(node).backgroundColor,
        borderLeft: getComputedStyle(node).borderLeftWidth,
        dots: node.querySelectorAll('.tc-cell-dot').length
      })))
    })()
  `))
  check('四个方格都带象限标识', cells.length === 4 && cells.every((cell) => cell.quadrant !== null), JSON.stringify(cells.map((cell) => cell.quadrant)))
  check('四个方格底色互不相同', new Set(cells.map((cell) => cell.background)).size === 4, JSON.stringify(cells.map((cell) => cell.background)))
  check('方格底色没有一个是纯白', cells.every((cell) => cell.background !== 'rgb(255, 255, 255)'), JSON.stringify(cells.map((cell) => cell.background)))
  check('方格左缘有强调条', cells.every((cell) => cell.borderLeft === '4px'), JSON.stringify(cells.map((cell) => cell.borderLeft)))
  check('方格标题不再渲染圆点', cells.every((cell) => cell.dots === 0), JSON.stringify(cells.map((cell) => cell.dots)))

  const cardState = JSON.parse(await cdp.evaluate(`
    (() => {
      const card = document.querySelector('.tc-card')
      const slot = card.querySelector('.tc-check-slot')
      const boxes = card.querySelectorAll('.tc-card-main .tc-check')
      return JSON.stringify({
        boxCount: boxes.length,
        label: boxes[0] === undefined ? null : boxes[0].getAttribute('aria-label'),
        slotOpacity: getComputedStyle(slot).opacity,
        titleTag: card.querySelector('.tc-card-title-button').tagName,
        hasMoreButton: card.querySelector('.tc-card-actions button[aria-expanded]') !== null
      })
    })()
  `))
  check('卡片上只有 1 个复选框', cardState.boxCount === 1, `数量 ${cardState.boxCount}`)
  check('复选框常显', cardState.slotOpacity === '1', `透明度 ${cardState.slotOpacity}`)
  check('浏览态复选框是完成框', cardState.label !== null && cardState.label.startsWith('完成'), `标签 ${cardState.label}`)
  check('卡片标题是按钮', cardState.titleTag === 'BUTTON', `标签名 ${cardState.titleTag}`)
  check('卡片操作区有更多操作按钮', cardState.hasMoreButton === true, '缺少更多操作按钮')

  await clickByText(cdp, '.tc-filterbar', '多选')
  await delay(300)
  const selecting = JSON.parse(await cdp.evaluate(`
    (() => {
      const card = document.querySelector('.tc-card')
      const boxes = card.querySelectorAll('.tc-card-main .tc-check')
      const toggle = [...document.querySelectorAll('.tc-filterbar button')].find((node) => getComputedStyle(node).display !== 'none' && node.getAttribute('aria-pressed') === 'true')
      return JSON.stringify({
        boxCount: boxes.length,
        label: boxes[0] === undefined ? null : boxes[0].getAttribute('aria-label'),
        pressed: toggle === undefined ? null : toggle.getAttribute('aria-pressed'),
        actions: [...card.querySelectorAll('.tc-card-actions button')]
          .filter((node) => {
            const style = getComputedStyle(node)
            const parent = getComputedStyle(node.parentElement)
            return style.visibility !== 'hidden' && parent.opacity !== '0' && parent.pointerEvents !== 'none'
          }).length
      })
    })()
  `))
  check('多选态卡片仍只有 1 个复选框', selecting.boxCount === 1, `数量 ${selecting.boxCount}`)
  check('多选态复选框变为选择框', selecting.label !== null && selecting.label.startsWith('选择'), `标签 ${selecting.label}`)
  check('多选开关处于按下状态', selecting.pressed === 'true', `aria-pressed ${selecting.pressed}`)
  check('多选态卡片不显示行内操作按钮', selecting.actions === 0, `数量 ${selecting.actions}`)

  await cdp.evaluate("document.querySelector('.tc-card .tc-check-slot .tc-check').click()")
  await delay(400)
  const batchbar = await cdp.evaluate("document.querySelector('.tc-batchbar') === null ? '' : document.querySelector('.tc-batchbar').innerText")
  check('选中后出现批量条', batchbar.includes('已选 1 项'), `批量条文本 ${batchbar}`)

  await cdp.evaluate(`
    (() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })()
  `)
  await delay(400)
  const afterEscape = JSON.parse(await cdp.evaluate(`
    (() => JSON.stringify({
      bar: document.querySelector('.tc-batchbar') === null,
      label: document.querySelector('.tc-card .tc-check-slot .tc-check').getAttribute('aria-label'),
      page: document.querySelector('.tc-page') !== null
    }))()
  `))
  check('Esc 先退出多选态', afterEscape.bar === true && afterEscape.label.startsWith('完成'), `批量条已清除 ${afterEscape.bar} 标签 ${afterEscape.label}`)
  check('退出多选后面板仍在', afterEscape.page === true, '面板被一起关闭了')

  const addClicked = await clickByLabel(cdp, '在紧急且重要添加待办')
  check('方格添加按钮可点击', addClicked === true, '没有找到添加按钮')
  await waitFor(cdp, "document.querySelector('.tc-editor') !== null", '添加面板打开', 15000)
  const emptyRows = await cdp.evaluate("document.querySelectorAll('.tc-editor input[aria-label^=\"子待办\"]').length")
  check('添加面板默认没有子待办输入行', emptyRows === 0, `行数 ${emptyRows}`)
  const addRow = await clickByText(cdp, '.tc-editor', '添加一行')
  check('添加一行按钮存在', addRow === true, '没有找到添加一行按钮')
  await delay(300)
  const rowState = JSON.parse(await cdp.evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('.tc-editor input[aria-label^="子待办"]')]
      return JSON.stringify({ count: rows.length, focused: rows[0] !== undefined && document.activeElement === rows[0] })
    })()
  `))
  check('点击后出现 1 行子待办输入', rowState.count === 1, `行数 ${rowState.count}`)
  check('新行自动获得焦点', rowState.focused === true, '焦点不在新行')

  await cdp.evaluate("document.querySelector('.tc-drawer-mask').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))")
  await delay(400)
  const editorClosed = await cdp.evaluate("document.querySelector('.tc-drawer') === null")
  check('点击遮罩关闭添加面板', editorClosed === true, '添加面板仍然存在')

  const collapsed = await clickByLabel(cdp, '收起紧急不重要')
  check('方格收起按钮可点击', collapsed === true, '没有找到收起按钮')
  await delay(400)
  const collapseState = JSON.parse(await cdp.evaluate(`
    (() => {
      const cell = document.querySelector('.tc-cell[data-tc-quadrant="urgent-not-important"]')
      const rect = cell.getBoundingClientRect()
      const grid = document.querySelector('.tc-grid')
      return JSON.stringify({
        className: cell.className,
        height: Math.round(rect.height),
        body: cell.querySelector('.tc-cell-body') === null,
        rows: getComputedStyle(grid).gridTemplateRows,
        neighbour: Math.round(document.querySelector('.tc-cell[data-tc-quadrant="not-urgent-not-important"]').getBoundingClientRect().height)
      })
    })()
  `))
  check('收起后方格带折叠类名', collapseState.className.includes('tc-cell-collapsed'), `类名 ${collapseState.className}`)
  check('收起后方格收缩到标题行', collapseState.height <= 48, `高度 ${collapseState.height}`)
  check('收起后列表区不再渲染', collapseState.body === true, '列表区仍然存在')
  check('同一行的另一个方格保持展开', collapseState.neighbour > 100, `相邻高度 ${collapseState.neighbour}`)

  await clickByLabel(cdp, '收起不重要不紧急')
  await delay(500)
  const bothCollapsed = JSON.parse(await cdp.evaluate(`
    (() => {
      const grid = document.querySelector('.tc-grid')
      const top = document.querySelector('.tc-cell[data-tc-quadrant="urgent-important"]').getBoundingClientRect().height
      const rows = getComputedStyle(grid).gridTemplateRows.split(' ')
      return JSON.stringify({ rows, top: Math.round(top) })
    })()
  `))
  check('同一行两个方格都收起后该行高度随内容收缩', bothCollapsed.rows[1] === 'auto' || Number.parseFloat(bothCollapsed.rows[1]) <= 48, `行高 ${bothCollapsed.rows.join(' / ')}`)

  await clickByLabel(cdp, '展开紧急不重要')
  await clickByLabel(cdp, '展开不重要不紧急')
  await delay(400)

  await clickByText(cdp, '.tc-header', '关闭')
  await delay(800)
  const finalState = JSON.parse(await cdp.evaluate(iconProbe))
  check('关闭面板后样式表仍为 1 个', finalState.styleCount === 1, `数量 ${finalState.styleCount}`)
  check('关闭面板后角标位置与打开时一致', finalState.badgePosition === 'absolute' && finalState.badgeTop === closed.badgeTop && finalState.badgeRight === closed.badgeRight, `position ${finalState.badgePosition} top ${finalState.badgeTop} right ${finalState.badgeRight}`)

  const relevantErrors = cdp.consoleErrors.filter((text) => !text.includes('favicon') && !text.includes('Download the React DevTools'))
  const foreignErrors = relevantErrors.filter((text) => text.includes('dsh-client-ui-open-in-app') && !text.includes('TodoCenterPage') && !text.includes('TodoCenterDock'))
  const ownErrors = relevantErrors.filter((text) => !foreignErrors.includes(text))
  check('插件自身没有脚本错误', ownErrors.length === 0, ownErrors.join(' | '))
  if (foreignErrors.length > 0) {
    console.log(`观察: 非本插件错误 ${foreignErrors.length} 条，堆栈落在 dsh-client-ui-open-in-app 的目录按钮上，出现在会话条目渲染路径`)
  }
} finally {
  if (cdp.consoleErrors.length > 0) console.log('页面错误明细:', JSON.stringify(cdp.consoleErrors, null, 2))
  if (cdp !== null) cdp.close()
  browser.kill()
  for (const item of (await apiSnapshot()).todos) {
    if (item.parentId === null) await apiPost('/remove', { ids: [item.id] })
  }
  for (const quadrant of QUADRANT_IDS) {
    await apiPost('/setCollapsed', { scopeKey: 'all', quadrant, collapsed: false })
  }
  // 恢复运行前的数据，并删除本套件产生的导入备份
  await apiPost('/import', { payload: originalData, fileName: 'ui-check-v11-restore.json' })
  const restored = await apiSnapshot()
  const signature = (value) => JSON.stringify({
    titles: value.todos.map((todo) => `${todo.title}|${todo.status}|${todo.quadrant}|${todo.dueAt}`).sort(),
    collapsed: value.collapsed,
    filters: value.filters.map((preset) => preset.name).sort()
  })
  check('结束时数据回到运行前的内容', signature(restored) === signature(originalData), `现状 ${signature(restored)} 运行前 ${signature(originalData)}`)
  let removedBackups = 0
  for (const name of await readdir(dataDir)) {
    if (name.startsWith('todos.before-import-') === false) continue
    const info = await stat(path.join(dataDir, name))
    if (info.mtimeMs < startedAt) continue
    await unlink(path.join(dataDir, name))
    removedBackups += 1
  }
  console.log(`清理导入备份 ${removedBackups} 个`)
  console.log(`----\n共 ${checks} 项，失败 ${failures.length} 项`)
  if (failures.length > 0) {
    console.log('失败项:', failures.join(' | '))
    exitCode = 1
  }
  if (todoId !== null) console.log(`清理完成，验证用待办 ${todoId} 已删除`)
  process.exitCode = exitCode
}
