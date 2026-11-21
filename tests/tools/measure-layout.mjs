// 布局度量：在真实页面里读取关键容器的几何与计算样式，只做测量，不改动数据
// 用法：node tests/tools/measure-layout.mjs [视口宽] [视口高]

import { launchAndConnect, readServerUrl, waitFor, clickByText } from '../cdp-harness.mjs'

const width = Number(process.argv[2] ?? 1920)
const height = Number(process.argv[3] ?? 1080)

const { browser, cdp } = await launchAndConnect(await readServerUrl())

const MEASURE = `
  (() => {
    const box = (node) => {
      if (node === null) return null
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        maxWidth: style.maxWidth,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        display: style.display,
        gridTemplateColumns: style.gridTemplateColumns,
        gridTemplateRows: style.gridTemplateRows,
        gap: style.gap,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage.slice(0, 120),
        borderLeftWidth: style.borderLeftWidth,
        borderLeftColor: style.borderLeftColor,
        transitionDuration: style.transitionDuration,
        animationName: style.animationName
      }
    }
    const page = document.querySelector('.tc-page')
    const shell = document.querySelector('.tc-shell')
    const grid = document.querySelector('.tc-grid')
    const cells = [...document.querySelectorAll('.tc-cell')].map((node) => ({
      quadrant: node.getAttribute('data-tc-quadrant'),
      cell: box(node),
      head: box(node.querySelector('.tc-cell-head')),
      body: box(node.querySelector('.tc-cell-body')),
      bodyScroll: node.querySelector('.tc-cell-body') === null
        ? null
        : {
          scrollWidth: node.querySelector('.tc-cell-body').scrollWidth,
          clientWidth: node.querySelector('.tc-cell-body').clientWidth
        }
    }))
    const cards = [...document.querySelectorAll('.tc-card')].slice(0, 4).map((node) => ({
      title: (node.querySelector('.tc-card-title') ?? { textContent: '' }).textContent.trim().slice(0, 24),
      box: box(node)
    }))
    const filterbar = document.querySelector('.tc-filterbar')
    const listHead = document.querySelector('.tc-list-head')
    const rows = [...document.querySelectorAll('.tc-list-row')].map((node) => box(node))
    const rangeSelects = [...document.querySelectorAll('select[aria-label="完成时间范围"]')]
    const rangeButtons = [...document.querySelectorAll('.tc-seg-btn')]
    return JSON.stringify({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      page: box(page),
      shell: box(shell),
      grid: box(grid),
      cells,
      cards,
      filterbar: filterbar === null
        ? null
        : { scrollWidth: filterbar.scrollWidth, clientWidth: filterbar.clientWidth, box: box(filterbar) },
      listHead: box(listHead),
      rows,
      cardCount: document.querySelectorAll('.tc-card').length,
      cellTexts: [...document.querySelectorAll('.tc-cell')].map((node) => {
        const body = node.querySelector('.tc-cell-body')
        return {
          quadrant: node.getAttribute('data-tc-quadrant'),
          cards: node.querySelectorAll('.tc-card').length,
          text: (body === null ? '' : body.textContent.trim()).slice(0, 40)
        }
      }),
      rangeControlCount: rangeSelects.length + rangeButtons.length,
      styleTagCount: document.querySelectorAll('style[data-plugin="dsh-4quadrant-todo"]').length
    })
  })()
`

try {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  })
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitFor(cdp, 'document.readyState === "complete"', '页面加载完成', 30000)
  await waitFor(cdp, `document.querySelector('.tc-icon-wrap') !== null`, '侧栏入口', 30000)

  const entered = await clickByText(cdp, 'body', '待办中心')
  if (entered !== true) {
    const byLabel = await cdp.evaluate(`
      (() => {
        const node = [...document.querySelectorAll('button,[role="button"]')]
          .find((item) => item.getAttribute('aria-label') === '待办中心')
        if (node === undefined) return false
        node.click()
        return true
      })()
    `)
    if (byLabel !== true) throw new Error('没有找到待办中心入口')
  }
  await waitFor(cdp, `document.querySelector('.tc-grid') !== null`, '四象限栅格', 30000)

  const quadrants = JSON.parse(await cdp.evaluate(MEASURE))
  console.log('== 四象限页 ==')
  console.log(JSON.stringify(quadrants, null, 2))

  const switched = await cdp.evaluate(`
    (() => {
      const tab = [...document.querySelectorAll('[role="tab"]')]
        .find((node) => (node.textContent || '').trim() === '已完成')
      if (tab === undefined) return false
      tab.click()
      return true
    })()
  `)
  if (switched === true) {
    await waitFor(cdp, `document.querySelector('.tc-filterbar') !== null`, '已完成页筛选条', 15000)
    const completed = JSON.parse(await cdp.evaluate(MEASURE))
    console.log('== 已完成页 ==')
    console.log(JSON.stringify({
      shell: completed.shell,
      filterbar: completed.filterbar,
      listHead: completed.listHead,
      rows: completed.rows,
      rangeControlCount: completed.rangeControlCount
    }, null, 2))
  }

  const SWEEP = `
    (() => {
      const overflow = [...document.querySelectorAll('.tc-page *')]
        .filter((node) => node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0)
        .slice(0, 12)
        .map((node) => ({
          tag: node.tagName.toLowerCase(),
          cls: node.className.slice(0, 48),
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth
        }))
      const page = document.querySelector('.tc-page')
      return JSON.stringify({
        pageOverflowX: page === null ? null : page.scrollWidth > page.clientWidth + 1,
        overflow,
        counts: {
          cells: document.querySelectorAll('.tc-cell').length,
          cards: document.querySelectorAll('.tc-card').length,
          sections: document.querySelectorAll('.tc-section').length,
          statCards: document.querySelectorAll('.tc-stat-card').length,
          weekBars: document.querySelectorAll('.tc-week-bar').length
        },
        heights: [...document.querySelectorAll('.tc-section')].map((node) => Math.round(node.getBoundingClientRect().height))
      })
    })()
  `

  for (const tab of ['四象限', '今日', '已完成', '统计']) {
    const chosen = await cdp.evaluate(`
      (() => {
        const node = [...document.querySelectorAll('[role="tab"]')]
          .find((item) => (item.textContent || '').trim() === ${JSON.stringify(tab)})
        if (node === undefined) return false
        node.click()
        return true
      })()
    `)
    if (chosen !== true) continue
    await new Promise((resolve) => setTimeout(resolve, 300))
    const swept = JSON.parse(await cdp.evaluate(SWEEP))
    console.log(`== 页签 ${tab} 溢出检查 ==`)
    console.log(JSON.stringify(swept, null, 2))
  }
} finally {
  cdp.close()
  browser.kill()
}
