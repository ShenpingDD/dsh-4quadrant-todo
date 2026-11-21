// 卡片单列排布、统一行高、倒计时贴右边缘，以及添加抽屉的可见性与键盘行为
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

function offsetSuffix() {
  const minutes = -new Date().getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const pad = (value) => String(value).padStart(2, '0')
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

const QUADRANT = 'not-urgent-not-important'
const QUADRANT_NAME = '不重要不紧急'
const OFFSET = offsetSuffix()

const appUrl = await readServerUrl()
const before = await apiSnapshot()
if (before.dataVersion === undefined) {
  console.log('Host 2.0 路由未就绪: GET /snapshot 缺少 dataVersion，先重启 3080 再运行本套件')
  process.exit(2)
}
const beforeIds = before.todos.map((todo) => todo.id)

const seeded = []
for (let index = 1; index <= 5; index += 1) {
  const created = await apiPost('/create', {
    title: `排布检查 ${index}`,
    description: index === 2 ? '这条带描述，卡片行高仍然与别的卡片相同' : '',
    dueAt: `2026-12-${String(10 + index).padStart(2, '0')}T18:00:00${OFFSET}`,
    quadrant: QUADRANT,
    source: { kind: 'manual' },
    tags: index === 1 ? ['甲', '乙', '丙'] : []
  })
  seeded.push(created.id)
}
await delay(300)

const { browser, cdp } = await launchAndConnect(appUrl)
let ownErrors = []

const MEASURE = `
  (() => {
    const rect = (node) => {
      const box = node.getBoundingClientRect()
      return {
        left: Math.round(box.left),
        top: Math.round(box.top),
        right: Math.round(box.right),
        bottom: Math.round(box.bottom),
        width: Math.round(box.width),
        height: Math.round(box.height)
      }
    }
    const cell = document.querySelector('.tc-cell[data-tc-quadrant="${QUADRANT}"]')
    const body = cell.querySelector('.tc-cell-body')
    const bodyStyle = getComputedStyle(body)
    const cards = [...body.querySelectorAll('.tc-card')]
    return JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      body: {
        ...rect(body),
        display: bodyStyle.display,
        flexDirection: bodyStyle.flexDirection,
        columnCount: bodyStyle.columnCount,
        clientWidth: body.clientWidth,
        clientHeight: body.clientHeight,
        scrollHeight: body.scrollHeight,
        paddingLeft: parseFloat(bodyStyle.paddingLeft),
        paddingRight: parseFloat(bodyStyle.paddingRight)
      },
      hasInlineEditor: body.querySelector('.tc-editor') !== null,
      cards: cards.map((card) => {
        const timeNode = card.querySelector('.tc-card-time')
        return {
          title: (card.querySelector('.tc-card-title')?.textContent ?? '').trim(),
          rect: rect(card),
          time: timeNode === null
            ? null
            : { text: (timeNode.textContent ?? '').trim(), rect: rect(timeNode), opacity: getComputedStyle(timeNode).opacity }
        }
      })
    })
  })()
`

try {
  await waitFor(cdp, "document.querySelector('.tc-icon-wrap') !== null", '侧栏图标出现', 40000)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await delay(500)
  const viewportWidth = await cdp.evaluate('window.innerWidth')
  if (viewportWidth !== 1440) throw new Error(`视口宽度未生效: 期望 1440，实际 ${viewportWidth}`)
  await clickByLabel(cdp, '待办中心')
  await waitFor(cdp, "document.querySelector('.tc-page') !== null", '待办中心页面渲染', 30000)
  await waitFor(cdp, `document.querySelectorAll('.tc-cell[data-tc-quadrant="${QUADRANT}"] .tc-card').length >= 5`, '五张卡片渲染', 20000)
  await delay(400)

  const measured = JSON.parse(await cdp.evaluate(MEASURE))
  const cards = measured.cards
  const lefts = cards.map((card) => card.rect.left)
  const widths = cards.map((card) => card.rect.width)
  const heights = cards.map((card) => card.rect.height)
  const tops = cards.map((card) => card.rect.top)

  check(
    'C1 每格卡片从同一左边缘起排',
    '五张卡片 left 与 width 完全一致',
    `left ${JSON.stringify(lefts)} width ${JSON.stringify(widths)}`,
    new Set(lefts).size === 1 && new Set(widths).size === 1
  )
  check(
    'C2 卡片逐行向下排列，没有并排',
    'top 严格递增',
    `top ${JSON.stringify(tops)}`,
    tops.every((top, index) => index === 0 || top > tops[index - 1])
  )
  check(
    'C3 卡片行高统一为 44 像素',
    '五张卡片 height 都为 44',
    `height ${JSON.stringify(heights)}`,
    heights.every((height) => height === 44)
  )
  check(
    'C4 卡片宽度等于内容区可用宽度',
    '卡片宽等于内容区 clientWidth 减去左右内边距',
    `卡片 ${widths[0]} 可用宽 ${measured.body.clientWidth - measured.body.paddingLeft - measured.body.paddingRight}`,
    Math.abs(widths[0] - (measured.body.clientWidth - measured.body.paddingLeft - measured.body.paddingRight)) <= 1
  )
  check(
    'C5 内容区是纵向单列容器',
    'display flex，flex-direction column',
    `display ${measured.body.display} direction ${measured.body.flexDirection} columnCount ${measured.body.columnCount}`,
    measured.body.display === 'flex' && measured.body.flexDirection === 'column'
  )
  check(
    'C6 内容区里没有内联添加表单',
    '.tc-cell-body 内不存在 .tc-editor',
    `存在内联编辑器 ${measured.hasInlineEditor}`,
    measured.hasInlineEditor === false
  )

  const timeRights = cards.map((card) => card.time === null ? null : card.time.rect.right)
  const timeGaps = cards.map((card) => card.time === null ? null : card.rect.right - card.time.rect.right)
  check(
    'C7 倒计时右边缘齐平',
    '每张卡片的倒计时 right 相同',
    `right ${JSON.stringify(timeRights)} 间距 ${JSON.stringify(timeGaps)}`,
    timeRights.every((right) => right !== null) && new Set(timeRights).size === 1
  )
  check(
    'C8 倒计时与卡片右边缘保持固定间距',
    '间距一致且在 8 到 14 像素之间',
    `间距 ${JSON.stringify(timeGaps)}`,
    new Set(timeGaps).size === 1 && timeGaps[0] >= 8 && timeGaps[0] <= 14
  )
  const timeTexts = cards.map((card) => card.time === null ? '' : card.time.text)
  check(
    'C9 倒计时文案按远近分档',
    '同一年内的截止写成月日与时刻',
    `文案 ${JSON.stringify(timeTexts)}`,
    timeTexts[0] === '12-11 18:00'
  )

  const scrollable = await cdp.evaluate(`
    (() => {
      const body = document.querySelector('.tc-cell[data-tc-quadrant="${QUADRANT}"] .tc-cell-body')
      const value = body.scrollHeight > body.clientHeight + 1
      body.scrollTop = body.scrollHeight
      return value
    })()
  `)
  await delay(300)
  const scrolled = await cdp.evaluate("document.querySelector('.tc-cell[data-tc-quadrant=\"" + QUADRANT + "\"] .tc-cell-body').getAttribute('data-tc-scrolled')")
  await cdp.evaluate("document.querySelector('.tc-cell[data-tc-quadrant=\"" + QUADRANT + "\"] .tc-cell-body').scrollTop = 0")
  check(
    'C10 内容区滚动时打上滚动标记',
    '可滚动时 data-tc-scrolled 为 1',
    `可滚动 ${scrollable} 标记 ${scrolled}`,
    scrollable === false || scrolled === '1'
  )

  const bodyHeightBefore = measured.body.clientHeight
  const firstCardBefore = cards[0].rect

  const addClicked = await clickByLabel(cdp, `在${QUADRANT_NAME}添加待办`)
  check('C11 方格添加按钮可点击', '抽屉打开', `点击结果 ${addClicked}`, addClicked === true)
  await waitFor(cdp, "document.querySelector('.tc-drawer') !== null", '添加抽屉打开', 15000)
  await delay(300)

  const drawerState = JSON.parse(await cdp.evaluate(`
    (() => {
      const rect = (node) => {
        const box = node.getBoundingClientRect()
        return { left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right), bottom: Math.round(box.bottom), width: Math.round(box.width), height: Math.round(box.height) }
      }
      const drawer = document.querySelector('.tc-drawer')
      const body = document.querySelector('.tc-cell[data-tc-quadrant="${QUADRANT}"] .tc-cell-body')
      const card = body.querySelector('.tc-card')
      const primary = [...drawer.querySelectorAll('.tc-drawer-foot button')].find((node) => (node.textContent ?? '').trim() === '添加')
      const grid = drawer.querySelector('.tc-quadrant-grid')
      const options = grid === null ? [] : [...grid.querySelectorAll('.tc-quadrant-option')]
      const quadrantField = grid === null ? null : grid.parentElement
      const editor = drawer.querySelector('.tc-editor')
      const titleLabel = editor === null ? null : editor.querySelector('.tc-field-name')
      const descField = [...(editor === null ? [] : editor.children)].find((node) => ((node.querySelector('.tc-field-name') || {}).textContent || '').trim() === '描述')
      const descArea = descField === undefined ? null : descField.querySelector('textarea')
      const fields = {
        quadrants: options.length,
        title: drawer.querySelectorAll('input[aria-label="标题"]').length,
        date: drawer.querySelectorAll('input[aria-label="截止日期"]').length,
        clock: drawer.querySelectorAll('input[aria-label="截止时刻"]').length,
        description: drawer.querySelectorAll('textarea[aria-label="描述"]').length,
        tagInputs: [...drawer.querySelectorAll('input')].filter((node) => node.placeholder === '输入标签后回车').length,
        children: [...drawer.querySelectorAll('button')].filter((node) => /添加一行|再添加一行/.test(node.textContent ?? '')).length,
        repeat: drawer.querySelectorAll('select[aria-label="重复频率"]').length,
        reminder: drawer.querySelectorAll('select[aria-label="提醒提前量"]').length
      }
      return JSON.stringify({
        mode: drawer.getAttribute('data-tc-drawer'),
        rect: rect(drawer),
        title: (drawer.querySelector('.tc-drawer-title')?.textContent ?? '').trim(),
        fields,
        quadrants: options.map((node) => ({
          name: node.getAttribute('aria-label'),
          checked: node.getAttribute('aria-checked'),
          height: rect(node).height,
          dot: getComputedStyle(node.querySelector('.tc-quadrant-dot')).backgroundColor,
          background: getComputedStyle(node).backgroundColor
        })),
        gapToTitle: quadrantField === null || titleLabel === null
          ? -1
          : Math.round(titleLabel.getBoundingClientRect().top - quadrantField.getBoundingClientRect().bottom),
        description: descField === undefined
          ? { field: 0, area: 0 }
          : { field: rect(descField).height, area: descArea === null ? 0 : rect(descArea).height },
        primary: primary === undefined ? null : rect(primary),
        bodyHeight: body.clientHeight,
        cardRect: rect(card),
        focused: document.activeElement === null ? '' : document.activeElement.getAttribute('aria-label'),
        bodyOverflow: getComputedStyle(body).overflowY
      })
    })()
  `))

  check(
    'C12 抽屉占满视口高度并贴在右侧',
    '高度等于视口高度，right 等于视口宽度',
    `抽屉 ${JSON.stringify(drawerState.rect)} 视口 ${JSON.stringify(measured.viewport)}`,
    Math.abs(drawerState.rect.height - measured.viewport.height) <= 1 && Math.abs(drawerState.rect.right - measured.viewport.width) <= 1
  )
  check(
    'C13 抽屉宽度为 420 像素',
    '视口宽于 1024 像素时取 420',
    `宽度 ${drawerState.rect.width}`,
    drawerState.rect.width === 420
  )
  check(
    'C14 抽屉标题为添加待办',
    '标题文本与模式一致',
    `标题 ${drawerState.title} 模式 ${drawerState.mode}`,
    drawerState.title === '添加待办' && drawerState.mode === 'create'
  )
  const fieldCount = Object.values(drawerState.fields).reduce((sum, value) => sum + value, 0)
  check(
    'C15 抽屉里八个字段齐全且没有标签输入',
    '象限四个选项加标题、日期、时刻、描述、子待办、重复、提醒各一，标签输入已移除',
    JSON.stringify(drawerState.fields),
    drawerState.fields.quadrants === 4
      && drawerState.fields.tagInputs === 0
      && Object.entries(drawerState.fields).every(([key, value]) => (key === 'quadrants' || key === 'tagInputs' ? true : value === 1))
      && fieldCount === 11
  )
  check(
    'C15b 象限以四个带颜色的选项呈现',
    '每个选项 33 像素以上高度、带彩色圆点、选中项底色与其余不同',
    JSON.stringify(drawerState.quadrants),
    drawerState.quadrants.length === 4
      && drawerState.quadrants.every((option) => option.height >= 33 && option.dot !== 'rgba(0, 0, 0, 0)')
      && new Set(drawerState.quadrants.map((option) => option.dot)).size === 4
      && drawerState.quadrants.filter((option) => option.checked === 'true').length === 1
      && drawerState.quadrants.filter((option) => option.checked === 'true')[0].background
        !== drawerState.quadrants.filter((option) => option.checked === 'false')[0].background
  )
  check(
    'C15c 象限与标题之间没有多余空白',
    '象限选项底边到标题标签顶边不超过 20 像素',
    `间距 ${drawerState.gapToTitle}`,
    drawerState.gapToTitle <= 20
  )
  check(
    'C15d 描述框吸收抽屉剩余高度',
    '描述框高度大于 200 像素',
    JSON.stringify(drawerState.description),
    drawerState.description.field > 200 && drawerState.description.area >= drawerState.description.field - 40
  )
  check(
    'C16 底部主按钮完整落在视口内',
    '按钮 bottom 不超过视口高度',
    `按钮 ${JSON.stringify(drawerState.primary)}`,
    drawerState.primary !== null && drawerState.primary.bottom <= measured.viewport.height
  )
  check(
    'C17 打开抽屉后卡片区高度不变',
    '内容区 clientHeight 与首张卡片位置都和打开前相同',
    `前 ${bodyHeightBefore} 后 ${drawerState.bodyHeight} 卡片 ${JSON.stringify(drawerState.cardRect)} 之前 ${JSON.stringify(firstCardBefore)}`,
    drawerState.bodyHeight === bodyHeightBefore
      && drawerState.cardRect.top === firstCardBefore.top
      && drawerState.cardRect.height === firstCardBefore.height
  )

  const focusIn = JSON.parse(await cdp.evaluate(`
    (() => {
      const panel = document.querySelector('.tc-drawer')
      const active = document.activeElement
      return JSON.stringify({
        inside: panel !== null && active !== null && panel.contains(active),
        label: active === null ? null : active.getAttribute('aria-label')
      })
    })()
  `))
  check('C18 打开抽屉后焦点进入面板内', 'activeElement 落在抽屉里', JSON.stringify(focusIn), focusIn.inside === true)

  await cdp.evaluate(`
    (() => {
      const active = document.activeElement ?? document.body
      active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })()
  `)
  await delay(400)
  const afterEscape = await cdp.evaluate("document.querySelector('.tc-drawer') === null")
  check('C19 Esc 关闭抽屉', '抽屉消失', `抽屉仍存在 ${afterEscape === false}`, afterEscape === true)

  await cdp.evaluate(`
    (() => {
      const button = [...document.querySelectorAll('button')]
        .find((node) => (node.getAttribute('aria-label') ?? '') === '在${QUADRANT_NAME}添加待办')
      button.focus()
      button.click()
    })()
  `)
  await waitFor(cdp, "document.querySelector('.tc-drawer') !== null", '抽屉重新打开', 15000)
  await delay(300)
  await cdp.evaluate(`
    (() => {
      const active = document.activeElement ?? document.body
      active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })()
  `)
  await delay(400)
  const focusBack = await cdp.evaluate("document.activeElement === null ? '' : (document.activeElement.getAttribute('aria-label') ?? '')")
  check(
    'C20 Esc 关闭后焦点回到触发按钮',
    '焦点回到方格添加按钮',
    `焦点 ${focusBack}`,
    focusBack === `在${QUADRANT_NAME}添加待办`
  )

  await clickByLabel(cdp, `在${QUADRANT_NAME}添加待办`)
  await waitFor(cdp, "document.querySelector('.tc-drawer') !== null", '抽屉再次打开', 15000)
  await cdp.evaluate("document.querySelector('.tc-drawer-mask').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))")
  await delay(400)
  const maskClosed = await cdp.evaluate("document.querySelector('.tc-drawer') === null")
  check('C21 点遮罩关闭抽屉', '抽屉消失', `抽屉仍存在 ${maskClosed === false}`, maskClosed === true)

  const hoverTarget = JSON.parse(await cdp.evaluate(`
    (() => {
      const body = document.querySelector('.tc-cell[data-tc-quadrant="${QUADRANT}"] .tc-cell-body')
      const card = body.querySelector('.tc-card')
      const box = card.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), height: Math.round(box.height), top: Math.round(box.top) })
    })()
  `))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverTarget.x, y: hoverTarget.y, buttons: 0 })
  await delay(400)
  const hoverState = JSON.parse(await cdp.evaluate(`
    (() => {
      const body = document.querySelector('.tc-cell[data-tc-quadrant="${QUADRANT}"] .tc-cell-body')
      const card = body.querySelector('.tc-card')
      const actions = card.querySelector('.tc-card-actions')
      const time = card.querySelector('.tc-card-time')
      const box = card.getBoundingClientRect()
      return JSON.stringify({
        height: Math.round(box.height),
        top: Math.round(box.top),
        actionsOpacity: actions === null ? null : getComputedStyle(actions).opacity,
        actionsPointer: actions === null ? null : getComputedStyle(actions).pointerEvents,
        timeOpacity: time === null ? null : getComputedStyle(time).opacity
      })
    })()
  `))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, buttons: 0 })
  check(
    'C22 悬浮不改变行高与位置',
    'height 与 top 和悬浮前一致',
    `${hoverTarget.height}/${hoverState.height} ${hoverTarget.top}/${hoverState.top}`,
    hoverState.height === hoverTarget.height && hoverState.top === hoverTarget.top
  )
  check(
    'C23 悬浮操作按钮盖住倒计时但不撑高卡片',
    '操作按钮可见可点，倒计时隐去',
    JSON.stringify(hoverState),
    hoverState.actionsOpacity === '1' && hoverState.actionsPointer === 'auto' && hoverState.timeOpacity === '0'
  )

  ownErrors = (cdp.consoleErrors ?? []).filter((text) => !text.includes('favicon') && !text.includes('open-in-app') && !text.includes('remote.session'))
  check('C24 页面没有本插件的脚本错误', '没有未捕获异常', ownErrors.join(' | '), ownErrors.length === 0)
} finally {
  const after = await apiSnapshot()
  const createdIds = after.todos.map((todo) => todo.id).filter((id) => beforeIds.includes(id) === false)
  if (createdIds.length > 0) await apiPost('/remove', { ids: createdIds })
  if (cdp !== null) cdp.close()
  browser.kill()
}

const final = await apiSnapshot()
const seededLeft = final.todos.filter((todo) => seeded.includes(todo.id))
check(
  'C25 结束时数据回到运行前',
  `待办 ${before.todos.length} 条`,
  `现状 ${final.todos.length} 条 残留 ${seededLeft.length} 条`,
  final.todos.length === before.todos.length
    && JSON.stringify(final.todos.map((todo) => todo.id).sort()) === JSON.stringify([...beforeIds].sort())
)

console.log('----')
console.log(`共 ${checks} 项，失败 ${results.filter((item) => item.pass !== true).length} 项`)
process.exitCode = results.filter((item) => item.pass !== true).length
