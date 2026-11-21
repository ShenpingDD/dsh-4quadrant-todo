// 静态审计：禁用字词、类名一致、组件引用完整、注释语言
// 只读检查，不修改任何文件

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')

const FORBIDDEN_CHARS = ['栈', '落', '死', '拆', '契约', '偏']
const FORBIDDEN_WORDS = ['落地', '对齐', '钉死']
const LONE_CHARS = ['粗', '细', '硬', '软', '实', '虚']

const results = []

function check(name, description, actual, pass) {
  results.push({ name, description, actual, pass })
  console.log(`${pass ? 'ok  ' : 'fail'} ${name}  ${description}`)
  if (!pass) console.log(`      实际: ${actual}`)
}

const jsFiles = [
  path.join(root, 'lib', 'index.js'),
  path.join(root, 'lib', 'client.js')
]
const docFiles = [
  path.join(root, 'docs', 'PRD-v2.md'),
  path.join(root, 'docs', 'api-v2.md'),
  path.join(root, 'docs', 'architecture-v2.md'),
  path.join(root, 'docs', 'ui-spec-v2.md')
]

const sources = new Map()
for (const file of [...jsFiles, ...docFiles]) {
  sources.set(file, await fsp.readFile(file, 'utf8'))
}

// ---------- 1. 禁用字词 ----------

{
  const hits = []
  for (const [file, text] of sources) {
    for (const word of [...FORBIDDEN_CHARS, ...FORBIDDEN_WORDS]) {
      let index = text.indexOf(word)
      while (index !== -1) {
        const line = text.slice(0, index).split('\n').length
        hits.push(`${path.basename(file)}:${line} ${word}`)
        index = text.indexOf(word, index + word.length)
      }
    }
  }
  check('S1', '禁用字与禁用词不出现', `${hits.length} 处: ${hits.slice(0, 8).join(' / ')}`, hits.length === 0)
}

{
  const hits = []
  for (const [file, text] of sources) {
    for (const lone of LONE_CHARS) {
      const pattern = new RegExp(`(?<![\\u4e00-\\u9fa5])${lone}(?![\\u4e00-\\u9fa5])`, 'g')
      const before = hits.length
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split('\n').length
        hits.push(`${path.basename(file)}:${line} ${lone}`)
      }
      if (hits.length === before) continue
    }
  }
  check('S2', '单字使用不出现', `${hits.length} 处: ${hits.slice(0, 8).join(' / ')}`, hits.length === 0)
}

// ---------- 2. 客户端类名与样式一致 ----------

{
  const client = sources.get(path.join(root, 'lib', 'client.js'))
  const styleStart = client.indexOf('const STYLE_TEXT = `')
  const styleEnd = client.indexOf('`\n', styleStart + 20)
  const styleText = client.slice(styleStart, styleEnd)
  const defined = new Set([...styleText.matchAll(/\.tc-([a-z0-9-]+)/g)].map((match) => match[1]))
  const used = new Set()
  for (const match of client.matchAll(/className: '([^']*)'/g)) {
    for (const token of match[1].split(' ')) {
      if (token.startsWith('tc-')) used.add(token.slice(3))
    }
  }
  for (const match of client.matchAll(/className: [^,\n]*\? '([^']*)' : '([^']*)'/g)) {
    for (const group of [match[1], match[2]]) {
      for (const token of group.split(' ')) {
        if (token.startsWith('tc-')) used.add(token.slice(3))
      }
    }
  }
  const missing = [...used].filter((name) => !defined.has(name))
  check('S3', '客户端使用的类名都有样式规则', `缺失: ${missing.join(', ')}`, missing.length === 0)
}

// ---------- 3. 组件引用完整 ----------

{
  const client = sources.get(path.join(root, 'lib', 'client.js'))
  const used = new Set([...client.matchAll(/h\(([A-Z][A-Za-z0-9]*)\s*,/g)].map((match) => match[1]))
  const defined = new Set([...client.matchAll(/function ([A-Z][A-Za-z0-9]*)\s*\(/g)].map((match) => match[1]))
  const missing = [...used].filter((name) => !defined.has(name))
  check('S4', '渲染到的组件都有定义', `缺失: ${missing.join(', ')}`, missing.length === 0)
}

// ---------- 4. 界面套件的选择器存在于样式表 ----------

{
  const client = sources.get(path.join(root, 'lib', 'client.js'))
  const styleStart = client.indexOf('const STYLE_TEXT = `')
  const styleEnd = client.indexOf('`\n', styleStart + 20)
  const styleText = client.slice(styleStart, styleEnd)
  const defined = new Set([...styleText.matchAll(/\.tc-([a-z0-9-]+)/g)].map((match) => match[1]))
  // 套件里用来断言「不渲染」的选择器不需要样式规则
  const ABSENT_BY_DESIGN = new Set(['cell-dot'])
  const suites = ['ui-check.mjs', 'ui-check-v11.mjs', 'ui-check-v2.mjs']
  const missing = []
  for (const suite of suites) {
    const text = await fsp.readFile(path.join(root, 'tests', suite), 'utf8')
    for (const match of text.matchAll(/\.tc-([a-z0-9-]+)/g)) {
      if (defined.has(match[1]) || ABSENT_BY_DESIGN.has(match[1])) continue
      missing.push(`${suite}:${match[1]}`)
    }
  }
  const unique = [...new Set(missing)]
  check('S9', '界面套件用到的类名都有样式规则', `缺失 ${unique.length} 个: ${unique.slice(0, 8).join(', ')}`, unique.length === 0)
}

// ---------- 5. 注册与插槽 ----------
{
  const client = sources.get(path.join(root, 'lib', 'client.js'))
  const slots = ['sidebar.panellist', 'main', 'shell.overlay', 'conversation.input.dock']
  const missing = slots.filter((slot) => !client.includes(`ctx.slots.inject('${slot}'`))
  const hasApply = client.includes('function apply(ctx)') && client.includes('apply\n    }')
  check('S5', '四个插槽注册与 apply 导出齐全', `缺失: ${missing.join(', ')} apply=${hasApply}`, missing.length === 0 && hasApply)
}

// ---------- 6. 客户端接口路径都在 Host 路由表内 ----------

{
  const host = sources.get(path.join(root, 'lib', 'index.js'))
  const client = sources.get(path.join(root, 'lib', 'client.js'))
  const hostRoutes = new Set([...host.matchAll(/\['(\/[A-Za-z\/]+)',/g)].map((match) => match[1]))
  const clientRoutes = new Set(
    [...client.matchAll(/(?:call|fetch)\(`?\$\{ROUTE\}(\/[A-Za-z]+(?:\/[a-z]+)?)/g)].map((match) => match[1])
  )
  for (const match of client.matchAll(/call\('(\/[A-Za-z\/]+)'/g)) clientRoutes.add(match[1])
  const missing = [...clientRoutes].filter((route) => !hostRoutes.has(route))
  check('S6', '客户端调用的路径都在 Host 路由表内', `Host ${hostRoutes.size} 条；越界: ${missing.join(', ')}`, missing.length === 0)
}

// ---------- 7. 注释使用中文 ----------

{
  const hits = []
  for (const file of jsFiles) {
    const text = sources.get(file)
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('//')) return
      const body = trimmed.slice(2).trim()
      if (body === '') return
      if (/^@@/.test(body)) return
      if (/[\u4e00-\u9fa5]/.test(body)) return
      // 只由标识符、路径与标点构成的注释行不计入
      const rest = body
        .replace(/[A-Za-z0-9_-]+/g, '')
        .replace(/[/`{}<>.,:=+*()[\]#|&"'!?;\\\s-]/g, '')
      if (rest === '') return
      hits.push(`${path.basename(file)}:${index + 1} ${body.slice(0, 40)}`)
    })
  }
  check('S7', '注释都使用中文', `${hits.length} 条英文注释: ${hits.slice(0, 5).join(' / ')}`, hits.length === 0)
}

// ---------- 8. 文档不含 ASCII 示意图 ----------

{
  const hits = []
  for (const file of docFiles) {
    const text = sources.get(file)
    const lines = text.split('\n')
    let fenced = false
    lines.forEach((line, index) => {
      if (line.trim().startsWith('```')) {
        fenced = !fenced
        return
      }
      if (fenced) return
      if (/[┌┐└┘├┤┬┴┼─│]/.test(line)) hits.push(`${path.basename(file)}:${index + 1}`)
    })
  }
  check('S8', '文档中无 ASCII 示意图', `${hits.length} 处: ${hits.slice(0, 5).join(' / ')}`, hits.length === 0)
}

const failed = results.filter((item) => item.pass !== true)
console.log('')
console.log(`共 ${results.length} 项，失败 ${failed.length}`)
process.exitCode = failed.length
