// 把备份文件导入回数据文件，用于套件中断后的恢复
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const API = 'http://127.0.0.1:3080/plugins/dsh-4quadrant-todo'

const file = process.argv[2]
if (typeof file !== 'string' || file.trim() === '') {
  throw new Error('用法: node tests/restore-backup.mjs <备份文件>')
}

const raw = await readFile(file, 'utf8')
const payload = JSON.parse(raw)
const response = await fetch(`${API}/import`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-dsh-todo': '1' },
  body: JSON.stringify({ payload, fileName: path.basename(file) })
})
const result = await response.json()
if (result.ok !== true) throw new Error(result.error)
console.log(`已导入 ${payload.todos.length} 条待办`)
