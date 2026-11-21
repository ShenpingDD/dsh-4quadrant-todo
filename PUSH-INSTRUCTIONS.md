# 推送说明（给另一台电脑上的 Agent）

这个压缩包是 DeepSeek Harness 插件「四象限待办 / 4Quadrant Todo」的完整源码，准备推到 GitHub 开源。本机无法登录 GitHub，所以由另一台电脑执行推送。

## 你手上是什么

```
4quadrant-todo/
  lib/index.js          Host 半：19 条 HTTP 路由、数据文件读写、提醒扫描
  lib/client.js         客户端半：侧栏入口、四象限面板、添加/编辑抽屉
  locale/*.json         中英文文案
  icon.svg              侧栏图标
  cordis.patch.yml      插件行，id 与 name 都是 dsh-4quadrant-todo
  scripts/feishu-sync.mjs   与飞书任务清单双向同步的脚本
  tests/                套件：Host 规则、接口校验、界面、同步
  docs/                 PRD、架构、界面规格、接口文档
  package.json          npm 包名 dsh-4quadrant-todo
  README.md             中英双语说明
  LICENSE               MIT
  .gitignore
```

零运行时依赖：客户端只 `require('react')`（宿主注入），Host 只用 Node 内置模块。克隆后不需要 `npm install` 就能跑 Host 侧检查。

## 推送前必须改一处

`package.json` 里有三处占位符 `GITHUB_OWNER`：

```json
"repository": { "type": "git", "url": "https://github.com/GITHUB_OWNER/4quadrant-todo.git" },
"homepage": "https://github.com/GITHUB_OWNER/4quadrant-todo#readme",
"bugs": { "url": "https://github.com/GITHUB_OWNER/4quadrant-todo/issues" }
```

换成实际账号名，例如 `https://github.com/lushouyun/4quadrant-todo.git`。README 里也有一处 `github:<owner>/4quadrant-todo`，同样替换。

## 推送步骤

```bash
cd 4quadrant-todo

# 1. 自检：三个入口文件语法 + 静态审计（不需要 DSH 在跑）
node --check lib/index.js
node --check lib/client.js
node --check scripts/feishu-sync.mjs
node tests/host-rules/audit-static.mjs

# 2. 初始化并提交
git init -b main
git add -A
git commit -m "feat: four-quadrant todo center for DeepSeek Harness with Lark Tasks sync"

# 3A. 已装 GitHub CLI 且已登录
gh repo create 4quadrant-todo --public --source=. --push \
  --description "Four-quadrant todos for DeepSeek Harness, two-way synced with Feishu (Lark) Tasks"

# 3B. 或先手动建好空仓库，再推
git remote add origin https://github.com/<账号>/4quadrant-todo.git
git push -u origin main
```

推送后建议再加一条 release tag：`git tag v2.0.0 && git push --tags`。

## 发布 npm（可选）

包名 `dsh-4quadrant-todo` 目前未被占用。发布前确认 `package.json` 里已是真实地址，然后：

```bash
npm publish --access public
```

`files` 字段已经限定为 `lib`、`locale`、`icon.svg`、`cordis.patch.yml`、`scripts`、`LICENSE`、`README.md`，测试与文档不会进包。

## 仓库设置建议

- About 里填：`Four-quadrant todos for DeepSeek Harness, two-way synced with Feishu (Lark) Tasks`
- Topics：`dsh`、`dsh-plugin`、`deepseek-harness`、`todo`、`eisenhower`、`four-quadrant`、`feishu`、`lark`
- 许可证选 MIT（仓库已带 LICENSE）

## 已知待更新项（不要当成缺陷去修，先如实保留）

1. `docs/` 里的 PRD、架构、接口文档仍写着旧插件名 `dsh-todo-center`，代码已经改名为 `dsh-4quadrant-todo`；这批文档要在后续一次提交里统一改名。
2. 「标签」字段还在界面与接口里，计划删除；删除后需要同步更新 `docs/api-v2.md`。
3. 仓库没有界面截图，README 未放图。

## 跑得更全的检查（可选，需要 DSH 环境）

```bash
node tests/host-rules/verify-api-v2.mjs      # 41 项
node tests/host-rules/verify-host-rules.mjs  # 39 项
node tests/ui-check-cards.mjs                # 界面，需要 dsh web 在 3080
node tests/ui-check-drag.mjs
```
