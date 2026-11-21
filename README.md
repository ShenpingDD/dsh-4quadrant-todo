# 4Quadrant Todo · 四象限待办

Four-quadrant (Eisenhower Matrix) todos inside DeepSeek Harness, two-way synced with Feishu / Lark Tasks, and able to turn a conversation's pending confirmations into real todos.

DeepSeek Harness 侧栏里的四象限待办中心：与飞书任务清单双向同步，并且能把会话里还没确认的事项直接变成待办。

## 为什么值得用 / Why this one

四象限待办插件在 DSH 生态里已经有两个，飞书相关的也有几个，但它们的组合里缺两块：

| 项目 | 四象限面板 | 飞书任务中心 | 双向同步 | 会话确认 → 待办 |
| --- | --- | --- | --- | --- |
| `ZIYE-JK/dsh-quadrant-todo` | 有 | 只把提醒发到飞书 | 无 | 无 |
| `Zhang-Eli/dsh-matrix-todo` | 有 | 无 | 无 | 无 |
| `zjuatri/dsh-feishu-plugin` | 无 | 查看与完成写回 | 单向 | 无 |
| `CAI-MH/dsh-feishu-task-recorder` | 无 | 抓群聊消息 | 与第三方任务板双向 | 无 |
| **本项目** | 有 | 四个清单承载象限 | **双向** | **有** |

三件事只有这个项目同时做到：四象限面板、与飞书任务清单双向同步、会话里的待确认项一键成待办。

## 功能 / Features

- **四象限面板**：每格纵向单列卡片，44 像素行高，标题在左、倒计时贴右边缘齐平；拖拽可跨象限移动。
- **时间压力可读**：倒计时分七档 —— 未安排、逾期（按分、时、天三档精度）、今天、明天、周X、同年月日、跨年；逾期文字与错误文字用 88% 混色。
- **飞书任务清单双向同步**：四个清单对应四个象限，本地与飞书任一侧的增删改、完成、换象限都会在下一轮同步中带到另一侧；冲突按修改时间较新的一方处理，结果写入 `sync.log`。
- **会话确认即待办**：DSH 会话里提问卡片的待确认项、工具执行前的审批，会出现在输入框上方的待确认条，点确认就写成待办，象限与截止时间可直接继承。
- **一句话录入**：输入「明天下午交报告 #重要」，解析日期、时段与象限标记，先给预览再确认。
- **完成留痕与复盘**：记下实际完成时间，已完成清单可按今天、本周、本月、自定义、全部查看，统计页给新增与完成数量、象限分布、完成率。
- **本地优先**：数据就是一个 JSON 文件，导出导入都在本机，导入前自动备份并支持撤销；没有账号体系。
- **零运行时依赖**：客户端只依赖 React，Host 只用 Node 内置模块；颜色全部走 DSH 主题令牌，深浅色自适应，系统开启「减少动态效果」时动效归零。

## 安装 / Install

要求：DSH 0.2.2-rc.1（本机实测）、Node.js 24。

```powershell
# 从 GitHub 源码 —— web 端
dsh plugin --profile web add github:ShenpingDD/dsh-4quadrant-todo

# 从 GitHub 源码 —— 桌面端（DSH.app）
dsh plugin --profile desktop add github:ShenpingDD/dsh-4quadrant-todo

# 或者从本地目录（开发时用，改客户端代码刷新页面即可）
dsh plugin --profile web add "link:/path/to/dsh-4quadrant-todo"
```

桌面端由 App 自己管理 profile，装插件走「插件 → 插件市场 / 安装本地插件」或在 App 内执行同样的 `github:` 规格；装完重启一次（`dsh web` 或 DSH.app），侧栏出现「待办中心」。

UI 自动化脚本（`tests/cdp-harness.mjs`）默认指向最初开发用的 Windows 路径，换机器用环境变量覆盖即可：`DSH_TEST_BROWSER`（Edge/Chrome 可执行文件）、`DSH_TEST_ORIGIN`（宿主地址，桌面端多为 `http://127.0.0.1:54916`）、`DSH_WEB_LOG`（写着访问地址的宿主日志）。

## 飞书同步怎么配 / Lark sync

在面板右上角点「飞书同步」：那里能看到 `lark-cli` 装没装、飞书账号登没登、四个象限各对应哪个飞书清单，也能直接生成一次性的飞书授权链接（浏览器确认或飞书扫码，窗口会自动检测结果）。四象限用四个飞书任务清单承载：一个象限对应一个清单，在飞书里把任务拖进/拖出清单，下一轮同步就会把象限变化带回本地。

前置条件（一次就好）：

1. 本机装 `lark-cli` 并登录出用户身份（`lark-cli auth status` 里 `user` 为 ready）。
2. 授权范围含 `task:task:read`、`task:task:write`、`task:tasklist:read`、`task:tasklist:write`；缺哪个面板里会直接写出来。

面板里的顺序：点「生成飞书授权链接」→ 在浏览器完成确认 → 状态变「可用」→ 点「帮我创建四个清单」（默认 `🔥 紧急且重要`、`⛰️ 紧急不重要`、`⛳ 重要不紧急`、`🛶 不重要不紧急`；也可以自己在飞书建好后在下拉里选）→「保存映射」→ 先「立即预演」看统计，再「立即同步」。

命令行等价物（不给 `--api` 时默认 `http://127.0.0.1:3080/plugins/dsh-4quadrant-todo`；桌面端端口每次可能不同，从面板触发最省事）：

```powershell
node scripts/feishu-sync.mjs --list-tasklists          # 列出账号下的清单名与 guid
node scripts/feishu-sync.mjs --dry-run                 # 预演：只统计不写入
node scripts/feishu-sync.mjs                           # 真同步
node scripts/feishu-sync.mjs --api http://127.0.0.1:54916/plugins/dsh-4quadrant-todo
```

数据目录默认 `~/.dsh/four-quadrant-todo`（`DSH_HOME` 覆盖一层，`--data-dir` 再覆盖一层）；`LARK_CLI` 环境变量可指向非 PATH 里的 lark-cli。

定时：面板「自动同步」里可以选 `关闭 / 每 5 / 15 / 30 / 60 分钟`，选完点「保存映射」生效。间隔由桌面端宿主按分钟检查、到点就跑一轮真同步（DSH 桌面端开着才跑；身份过期或清单没配齐时静默跳过，不会写坏数据）。脚本本身仍然不管调度，用命令行时可以交给 DSH 自动化任务或系统计划任务。

同步规则：`urgent-important` 等四个键与插件内部的象限标识一一对应；飞书侧不在四个清单里的任务（例如你放进「其他」的）不参与同步；本地删除只把任务移出清单，不删飞书里的任务；两侧都改过的按修改时间较新的一方整条覆盖，结果写进 `sync.log`。

## 数据位置 / Data

- 待办：`<DSH_HOME>/four-quadrant-todo/todos.json`，`DSH_HOME` 默认 `~/.dsh`
- 同步配置：`<DSH_HOME>/four-quadrant-todo/sync-config.json`
- 同步映射：`sync-state.json`；同步日志：`sync.log`
- 导入前备份：`todos.before-import-<时间戳>.json`

格式版本为 2；1.0 数据会只读展示并提供升级按钮，文件损坏时阻止加载并报错，不做自动迁移。

## 开发 / Development

```powershell
node --check lib/index.js
node --check lib/client.js
node --check scripts/feishu-sync.mjs

node tests/host-rules/verify-api-v2.mjs
node tests/host-rules/verify-host-rules.mjs
node tests/host-rules/audit-static.mjs
node tests/ui-check-cards.mjs
node tests/ui-check-edit.mjs
node tests/ui-check-drag.mjs
```

前三个套件自带宿主（真实 `node:http` + 临时数据目录 `tests/host-rules/.run`），不需要 DSH 在跑，任何平台都能直接执行：macOS 14 上 `verify-api-v2` 56/56、`verify-host-rules` 39/39、`audit-static` 9/9 全绿（2026-11-21 复验，DSH 0.2.2-rc.5；同步接口用 `tests/host-rules/stub-lark-cli.mjs` 假 CLI，不会碰真实飞书账号）。

浏览器套件用无头 Edge 通过 CDP 打开界面，需要宿主在跑（默认 `http://127.0.0.1:3080`，桌面端用 `DSH_TEST_ORIGIN` 指向它自己的端口）；会清空待办再恢复的套件在运行前把完整数据写到 `tests/.run/backups`，中断后用 `node tests/restore-backup.mjs <备份文件>` 导回。

## 兼容性 / Compatibility

| DSH | 插件 | 结论 |
| --- | --- | --- |
| 0.2.2-rc.1 | 2.0.0 | 已验证（Host 路由 19 条、界面套件全绿） |
| 0.2.2-rc.5 | 2.0.1 | 已验证（macOS 14 + 桌面端 profile：snapshot 200、41/41 API、39/39 规则、9/9 静态守卫，侧栏「待办中心」已注册） |

## 版本历史 / Changelog

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可 / License

MIT，见 [LICENSE](LICENSE)。界面与交互未复制其他项目的代码；同类项目的差异见上表。
