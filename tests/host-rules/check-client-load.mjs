// 客户端加载检查：在 3080 上确认真实页面能加载新的 lib/client.js 并完成注册
// 只读页面操作，不改动数据文件

import { launchAndConnect, waitFor, clickByLabel, clickByText, readServerUrl } from '../cdp-harness.mjs'

const results = []

function check(name, description, actual, pass) {
  results.push({ name, description, actual, pass })
  console.log(`${pass ? 'ok  ' : 'fail'} ${name}  ${description}`)
  if (!pass) console.log(`      实际: ${actual}`)
}

const appUrl = await readServerUrl()
const { browser, cdp } = await launchAndConnect(appUrl)

try {
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitFor(cdp, 'document.readyState === "complete"', '页面加载完成', 30000)

  const icon = await waitFor(
    cdp,
    `(() => {
      const node = document.querySelector('.tc-icon-wrap')
      if (node === null) return null
      return { svg: node.querySelector('svg') !== null, dot: node.querySelector('.tc-badge-dot') !== null }
    })()`,
    '侧栏入口图标',
    30000
  )
  check('K1', '侧栏入口图标渲染', `svg=${icon.svg}`, icon.svg === true)

  const styles = await cdp.evaluate(
    `document.querySelectorAll('style[data-plugin="dsh-4quadrant-todo"]').length`
  )
  check('K2', '整页只有一份插件样式表', `数量=${styles}`, styles === 1)

  const clicked = await clickByLabel(cdp, '待办中心')
  check('K3', '侧栏入口可点击', `clicked=${clicked}`, clicked === true)

  const tabs = await waitFor(
    cdp,
    `(() => {
      const nodes = [...document.querySelectorAll('[role="tab"]')].map((node) => (node.textContent || '').trim())
      return nodes.length === 4 ? nodes : null
    })()`,
    '四个页签',
    30000
  )
  const expected = ['四象限', '今日', '已完成', '统计']
  check('K4', '四个页签顺序正确', `tabs=${tabs.join(',')}`, JSON.stringify(tabs) === JSON.stringify(expected))

  const quick = await cdp.evaluate(
    `document.querySelector('.tc-quick-input') !== null || document.querySelector('.tc-quick') !== null`
  )
  check('K5', '快速录入条渲染', `present=${quick}`, quick === true)

  const cells = await cdp.evaluate(
    `[...document.querySelectorAll('.tc-cell[data-tc-quadrant]')].map((node) => node.getAttribute('data-tc-quadrant')).join(',')`
  )
  check(
    'K6',
    '四个方格按栅格顺序渲染',
    `cells=${cells}`,
    cells === 'urgent-important,not-urgent-important,urgent-not-important,not-urgent-not-important'
  )

  const exceptions = cdp.consoleErrors.filter((entry) => entry.startsWith('exception:'))
  check('K7', '加载与渲染没有未捕获异常', `${exceptions.length} 条: ${exceptions.slice(0, 3).join(' / ')}`, exceptions.length === 0)

  const cardCount = await cdp.evaluate(`document.querySelectorAll('[data-tc-todo-id]').length`)
  if (cardCount > 0) {
    const opened = await cdp.evaluate(`
      (() => {
        const more = document.querySelector('[aria-label^="更多操作："]')
        if (more === null) return false
        more.click()
        return true
      })()
    `)
    const editClicked = opened === true ? await clickByText(cdp, '[role="menu"]', '编辑') : false
    const dialog = editClicked === true
      ? await waitFor(
        cdp,
        `(() => {
          const node = document.querySelector('[role="dialog"]')
          if (node === null) return null
          const labelledBy = node.getAttribute('aria-labelledby')
          const label = labelledBy === null ? null : document.getElementById(labelledBy)
          return {
            modal: node.getAttribute('aria-modal'),
            title: label === null ? '' : (label.textContent || '').trim(),
            fields: node.querySelectorAll('input,textarea,select').length
          }
        })()`,
        '编辑对话框',
        15000
      )
      : null
    check(
      'K8',
      '编辑对话框可打开且有无障碍名称',
      `存在待办=${cardCount} 标题=${dialog === null ? '无' : dialog.title} 字段=${dialog === null ? 0 : dialog.fields}`,
      dialog !== null && dialog.modal === 'true' && dialog.title === '编辑待办' && dialog.fields >= 5
    )

    const escaped = await cdp.evaluate(`
      (() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        return true
      })()
    `)
    const closed = escaped === true
      ? await waitFor(cdp, `document.querySelector('[role="dialog"]') === null`, '对话框关闭', 10000)
      : false
    check('K9', 'Escape 关闭对话框', `closed=${closed}`, closed === true)
  } else {
    console.log('      当前数据里没有待办，跳过对话框检查')
  }

  const todoErrors = cdp.consoleErrors.filter((entry) => entry.includes('dsh-4quadrant-todo') && entry.includes('reminders'))
  console.log(`      提醒轮询告警 ${todoErrors.length} 条`)
} finally {
  cdp.close()
  browser.kill()
}

const failed = results.filter((item) => item.pass !== true)
console.log('')
console.log(`共 ${results.length} 项，失败 ${failed.length}`)
process.exitCode = failed.length
