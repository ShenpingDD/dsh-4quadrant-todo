// 运行前把真实数据写入磁盘备份，清理或导入失败时可以从备份恢复到原样
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const backupDir = path.join(here, '.run', 'backups')

export async function saveBackup(exported, tag) {
  await mkdir(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(backupDir, `${stamp}-${tag}.json`)
  await writeFile(file, JSON.stringify(exported, null, 2), 'utf8')
  console.log(`数据备份：${file}`)
  return file
}
