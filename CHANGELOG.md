# 版本历史 / Changelog

本文件记录面向使用者的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.0.3] — 2026-11-21

### 新增
- `package.json` 声明 `engines.dsh`：`">=0.2.2-rc.1 <0.3.0-0"`。此前 README 写了版本门槛但包内没有声明，宿主无法在安装期拦下旧版本，只能等运行期报错。

### 修复
- POSIX 上宿主约束用例 C21 补上「数据目录也设只读」的判定：目录可写时，仅把文件设为只读仍可用 rename 覆盖，原用例在 macOS/Linux 上会漏判。

## [2.0.2] — 2026-11-21

### 修复
- 宿主套件在 macOS/Linux 上全绿（此前按 Windows 语义判定，跨平台会误报）。

## [2.0.1] — 2026-11-21

### 新增
- README 补 `--profile desktop` 用法与桌面端安装步骤。
- `tests/cdp-harness.mjs` 的浏览器路径、CDP 端口、宿主地址、宿主日志路径支持环境变量覆盖：`DSH_TEST_BROWSER`、`DSH_TEST_CDP_PORT`、`DSH_TEST_ORIGIN`、`DSH_WEB_LOG`。默认值仍保留最初开发机（Windows）的取值。
- 插件数据目录兼容 `HOME`，不再只认 `USERPROFILE`。

## [2.0.0] — 2026-11-21

### 新增
- 首次发布：DeepSeek Harness 侧栏的四象限待办中心（艾森豪威尔矩阵看板、拖拽换象限、提醒）。
- 与飞书 / Lark 任务清单双向同步（`/sync/*` 接口与 `scripts/feishu-sync.mjs`）。
- 把会话里尚未确认的事项一键转成待办。
- 自带宿主约束与 API 用例：`tests/host-rules/`（含 `audit-static.mjs`）、`tests/verify-api-v2.mjs`。
