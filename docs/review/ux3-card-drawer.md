# 卡片行与右侧抽屉的样式规范（UX 3.0）

依据：task-24 冻结口径 5 条，需求方三点诉求（四象限每格单列、顶部起排、行高一致、倒计时贴右、添加与编辑走右侧抽屉）。读取快照：`todo-center/lib/client.js` 4095 行，`node --check lib/client.js` 通过；`tests/ui-check-cards.mjs` 365 行（2026-11-09 13:52 新建）。两个文件在本次分析期间被并发修改，行号按此快照给出，引用处同时给出选择器、函数名或检查项名称，行号移动后可按名检索。

## 1 卡片行规格

### 1.1 盒模型数值

| 部件 | 数值 | 说明 |
| --- | --- | --- |
| 卡片总高 | 44 像素（需要 `box-sizing:border-box`） | 含上下各 0.5 像素边框，左缘 3 像素 |
| 卡片内边距 | 上下 0，左右 10 像素 | 单行内容垂直居中 |
| 列 | `24px minmax(0,1fr) 104px`，列距 10 像素 | 勾选、标题、倒计时 |
| 勾选控件 | 16×16，居中于 24 像素控件位 | `.tc-check-slot`、`.tc-check` |
| 标题 | 13 像素加粗，单行省略 | 象限圆点 6 像素 + 标题 + 行内标记 |
| 行内标记 | 高 16 像素；标签 20 像素 | 标签最多 2 个加超出计数、描述、进度、重复、来自会话、已发起会话 |
| 倒计时 | 12 像素、等宽数字、靠右 | 右边缘与卡片内缘一致，间距 10 像素 |
| 悬浮操作 | 两个 24 像素按钮，覆盖在 104 像素列上 | 行高不变 |
| 会话错误行 | 12 像素一行，卡片高度自动 | `.tc-card-has-error` |

### 1.2 标题列宽度预算

标题列可用宽度 = 方格宽 − 12（内容区内边距左右各 6）− 4.5（方格左缘 4 加右框 0.5）− 20（卡片内边距左右各 10）− 4（卡片左缘 3 加右框 0.5）− 24（勾选列）− 10 − 104 − 10。

以方格宽 446 像素估算，标题列约 257 像素（估算，未实测）。行内标记全部出现时的内容宽度约 340 至 380 像素（估算：2 个双字标签各 36、超出计数 24、描述 38、进度 38、重复 38、来自会话 60、已发起会话 71，加 6 个 6 像素间距）。标题与标记都以内容宽度为收缩基准时，标记多的卡片会把标题压到 0。§3 的 `.tc-card-title-button{flex:1 1 auto;min-width:96px}` 让标题保住 96 像素下限，标记尾部被裁剪。

### 1.3 倒计时列宽度核算

跨年文案 `2027-01-03 14:00` 共 16 个字符：12 个数字、2 个连字符、1 个空格、1 个冒号。12 像素等宽数字按 0.55 em 估算，数字 79.2，连字符 8.6，空格与冒号各 3.0，合计约 93.8 像素，104 像素列余量约 10 像素（估算，字体取系统界面字体，未在浏览器量取）。今年内文案 `11-05 14:00` 约 74 像素，今天与明天文案约 62 像素，星期文案约 68 像素，逾期文案最长约 67 像素。

该列不设右内边距，字号保持 12 像素，`font-variant-numeric:tabular-nums`，`letter-spacing:0`。跨年段带时刻仍可容纳；中文格式「2027年1月3日 14:00」会超过 104 像素，因此跨年段保持数字格式。

## 2 既有 `.tc-card-*` 选择器影响面

| 选择器 | 现状（快照行号） | 与 44 像素单行、单列的关系 | 处置 |
| --- | --- | --- | --- |
| `.tc-card` | L1020，`height:44px`，未设 `box-sizing` | 边框 0.5 加 0.5 计入外部尺寸时渲染高度为 45 | 补 `box-sizing:border-box` |
| `.tc-card:hover` | L1022，阴影与三边描边，无位移 | 符合「悬浮不再上移」 | 保留；`transition` 必须留在 `.tc-card`，`tests/ui-layout.mjs` 的 L7 断言过渡时长非 0 |
| `.tc-card-overdue` | L1023，上右下 1 像素错误色 | 与 44 像素高度相容 | 保留 |
| `.tc-card-selected` | L1024，`border-color` 简写 | 覆盖逾期描边与左缘强调色，同特异性且后定义 | 改为内描边加左缘色 |
| `.tc-card-highlight` | L1025，同上 | 同上 | 同上 |
| `.tc-card[data-tc-card-quadrant]` | L1027-1030，56% 混 `label-primary` | 左缘 3 像素与圆点取同一强调色 | 保留；对比度见 §6.3 |
| `.tc-card-dot` | L1031，6 像素圆点 | 单行内 | 保留 |
| `.tc-card-main` | L1032，三列网格 | 单列卡片的行内布局 | 保留 |
| `.tc-card-head` | L1033，`overflow:hidden` | 标题与标记的裁剪边界 | 保留 |
| `.tc-card-title-button` | L1034，`flex:0 1 auto` | 标记多时标题先被压缩 | 改 `flex:1 1 auto;min-width:96px` |
| `.tc-card-marks` | L1037，`flex:0 1 auto`，`overflow:hidden` | 与标题争抢宽度 | 保留，由标题下限决定裁剪位置 |
| `.tc-card-side` | L1041，`position:relative` | 悬浮层定位基准 | 保留 |
| `.tc-card-time` | L1042，12 像素等宽数字 | 贴右显示 | 保留 |
| `.tc-card-time-late` | L1043，原生 `state-error` | 暗色下 4.24，低于 12 像素文字所需 4.5 | 改 88% 混 `label-primary`，见 §6.3 |
| `.tc-card-actions` | L1044，`visibility:hidden` | 隐藏子树的控件不能获得焦点，键盘无法到达「更多操作」，验收 74 的卡片操作按钮路径断裂 | 改 `opacity:0` 与 `pointer-events:none`，`:focus-within` 复原 |
| `.tc-card-error` | L1048，错误色 12 像素 | 暗色下原生错误色 4.24 | 随 `.tc-card-time-late` 取同色 |
| `.tc-card-flow` | L1015、L2864 起的卡片容器，`gap:6px` | 与 `.tc-cell-body` 的 `gap:6px` 同层，卡片间距仍为 6 | 保留；可并入 `.tc-cell-body`，不影响测量 |
| `.tc-card-meta-item` | L1110，仅用于已完成清单行（L3747-3750） | 卡片不再使用 | 保留给已完成清单 |
| `.tc-card-mark-late` | L1039，无引用 | 死规则 | 删除 |
| `overdueText` | L347-358，无引用 | 死函数 | 删除 |

## 3 样式交付

以下规则为最终状态，按原顺序替换同名规则；未列出的规则保持不变。

```css
/* 四象限方格：格头固定，内容区单列纵排 */
.tc-cell-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;padding:8px 10px;background-color:inherit;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.tc-cell-body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:6px;display:flex;flex-direction:column;gap:6px;scrollbar-gutter:stable}
.tc-cell-body[data-tc-scrolled="1"]{box-shadow:inset 0 1px 0 0 color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent)}

/* 卡片：单行三列，行高固定 */
.tc-card{box-sizing:border-box;position:relative;display:flex;align-items:center;height:44px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l1);border-left:3px solid var(--tc-card-accent,var(--dsw-alias-border-l1));background:var(--dsw-alias-bg-layer-2);animation:tc-rise var(--tc-dur-base) var(--tc-ease);transition:box-shadow var(--tc-dur-fast) var(--tc-ease),background-color var(--tc-dur-fast) var(--tc-ease),border-color var(--tc-dur-fast) var(--tc-ease)}
.tc-card-has-error{height:auto;flex-direction:column;align-items:stretch;padding:6px 10px;row-gap:4px}
.tc-card:hover{box-shadow:var(--dsw-shadow-lv2);border-top-color:var(--dsw-alias-border-l3);border-right-color:var(--dsw-alias-border-l3);border-bottom-color:var(--dsw-alias-border-l3)}
.tc-card-overdue{border-top:1px solid var(--dsw-alias-state-error-primary);border-right:1px solid var(--dsw-alias-state-error-primary);border-bottom:1px solid var(--dsw-alias-state-error-primary)}
.tc-card-selected{box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary);border-left-color:var(--dsw-alias-brand-primary)}
.tc-card-highlight{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary);border-left-color:var(--dsw-alias-state-business-primary)}
.tc-card-main{display:grid;grid-template-columns:24px minmax(0,1fr) 104px;column-gap:10px;align-items:center;flex:1 1 auto;min-width:0}
.tc-card-head{display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden}
.tc-card-title-button{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:96px;overflow:hidden;text-align:left;background:none;border:0;padding:0;color:inherit;font:var(--dsw-font-xs-strong-13);cursor:pointer}
.tc-card-marks{display:flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0;overflow:hidden}
.tc-card-side{position:relative;display:flex;align-items:center;justify-content:flex-end;min-width:0}
.tc-card-time{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity var(--tc-dur-fast) var(--tc-ease)}
.tc-card-time-late{color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 88%,var(--dsw-alias-label-primary))}
.tc-card-actions{position:absolute;top:50%;right:0;transform:translateY(-50%);display:flex;gap:2px;align-items:center;padding-left:12px;background:linear-gradient(to right,transparent,var(--dsw-alias-bg-layer-2) 12px);opacity:0;pointer-events:none;transition:opacity var(--tc-dur-fast) var(--tc-ease)}
.tc-card:hover .tc-card-actions,.tc-card:focus-within .tc-card-actions{opacity:1;pointer-events:auto}
.tc-card:hover .tc-card-time,.tc-card:focus-within .tc-card-time{opacity:0}
@media (hover:none){.tc-card-actions{opacity:1;pointer-events:auto}.tc-card-time{visibility:hidden}}
.tc-card-error{padding:0;color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 88%,var(--dsw-alias-label-primary));font:var(--dsw-font-xxs-12);min-width:0;overflow-wrap:anywhere}

/* 右侧抽屉：遮罩靠右，面板占满面板高度 */
.tc-drawer-mask{align-items:stretch;justify-content:flex-end;overscroll-behavior:contain}
.tc-drawer{width:420px;max-width:100vw;height:100%;max-height:none;padding:0;gap:0;overflow:hidden;border-radius:var(--dsw-radius-md) 0 0 var(--dsw-radius-md);border-right:0;animation:tc-drawer-in 180ms var(--tc-ease)}
.tc-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.tc-drawer-body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.tc-drawer-foot{justify-content:flex-end;flex:0 0 auto;margin-top:0;padding:12px 16px;border-top:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
@keyframes tc-drawer-in{from{transform:translateX(24px);opacity:0}to{transform:translateX(0);opacity:1}}
@media (max-width:1024px){.tc-drawer{width:92vw}}
```

三处取值理由：

1. `.tc-card-selected` 与 `.tc-card-highlight` 改用内描边，逾期卡片的上、右、下 1 像素错误色描边在选中或高亮期间仍然成立。内描边与悬浮阴影共用 `box-shadow`，选中态规则在级联中位于悬浮规则之后，两者同时成立时以选中态为准。
2. 格头固定由结构保证：格头与内容区是兄弟节点，内容区滚动不影响格头。`position:sticky` 在格头被移入滚动容器时仍然生效，`background-color:inherit` 使粘附时不被卡片内容穿透。
3. `.tc-cell-body[data-tc-scrolled="1"]` 由 `onScroll`（L3098-3099）写入，取 1 像素内阴影。浅色以 `label-primary` 14% 混透明，暗色同一条规则自动变亮，不使用固定颜色。

## 4 抽屉的无障碍与键盘必须项

| 项 | 必须行为 | 当前实现证据 | 结论 |
| --- | --- | --- | --- |
| 结构类名 | 保留 `.tc-modal`、`.tc-modal-mask`、`.tc-modal-title`、`.tc-modal-actions`，新增 `.tc-drawer`、`.tc-drawer-mask`、`.tc-drawer-title`、`.tc-drawer-foot` | L3633-3687：`tc-modal-mask tc-drawer-mask`（L3633）、`tc-modal tc-drawer`（L3637）、`tc-modal-title tc-drawer-title`（L3646）、`tc-modal-actions tc-drawer-foot`（L3685） | 符合 |
| 模式标记 | 根节点 `data-tc-drawer=create` 或 `edit` | L3641 | 符合 |
| 尺寸 | 宽 420；视口小于 1024 时 92vw；占满高度；左侧圆角 | L1080、L1086 | 符合 |
| 面板高度基准 | 遮罩 `position:fixed`，`.tc-page` 有 `container-type:inline-size`，固定定位以面板为基准 | L839、L1066、L3633 | 符合：抽屉高度等于面板高度，单面板布局下与「占满视口高度」一致 |
| 挂载位置 | 挂在 `.tc-page` 直接子级，避开滚动容器与卡片 `transform` | L2158，与 `.tc-shell` 同级 | 符合 |
| 对话框语义 | `role=dialog`、`aria-modal=true`、`aria-labelledby` 指向标题 | L3637-3641 | 符合 |
| 焦点进入 | 打开后焦点落在标题输入框 | L3683 `autoFocus:true` | 符合 |
| 焦点返回 | 关闭后焦点回到打开它的控件 | L3591-3597 记录 `document.activeElement`，清理时聚焦 | 符合；触发控件被重新渲染移除时焦点退回文档，需要断言区分 |
| Tab 循环 | Tab 与 Shift+Tab 在抽屉内首尾相接 | L3609-3631 | 部分符合：焦点不在抽屉内（点击抽屉空白处后按 Tab）时不拦截，焦点会跑到背后页面。最小修复：取 `focusable` 之前判断 `panel.contains(document.activeElement) === false` 时 `preventDefault()` 并聚焦首项 |
| Esc | 关闭抽屉；保存中不关闭 | L3610-3615 判断 `busy` 后 `stopPropagation`；窗口级 Esc 链另有 `editor` 分支（L1393 起） | 符合 |
| 遮罩关闭 | 点击遮罩关闭；保存中不关闭 | L3633-3635 `target === currentTarget` 且 `busy !== true` | 符合 |
| 滚动锁 | 打开期间背景不滚动 | L3591-3597 把 `document.body.style.overflow` 置为 `hidden`；抽屉与 `.tc-shell` 同级，窄容器下 `.tc-shell{overflow-y:auto}`（L1122）不在遮罩的滚动路径上 | 符合；`.tc-drawer-body` 与遮罩缺 `overscroll-behavior:contain`，滚到边界后滚动链传给文档 |
| 关闭按钮 | 有可读名称 | L3644-3653，`aria-label="关闭面板"`，`title="关闭"` | 符合；两处文案建议统一为「关闭面板」 |
| 焦点可见 | 抽屉内每个可操作控件都有可见焦点环 | L881 的 `:focus-visible` 覆盖 `.tc-button`、`.tc-icon-button`、`.tc-select`、`.tc-input`、`.tc-textarea` | 符合 |
| 保存中 | 按钮禁用并显示进行中 | L3686-3687 | 符合；建议给面板根补 `aria-busy` |

## 5 验收条款与套件断言的同步状态

| 位置 | 现有内容 | 单列固定行高后的判定 | 处置 |
| --- | --- | --- | --- |
| `docs/PRD.md:80` | 每格独立滚动，不出现整页滚动 | 不受影响 | 不改 |
| `docs/PRD.md:119` | 卡片自上而下为标题、截止时间、子待办进度、来源标记、操作入口 | 与单行三列冲突 | 改写为单行三列的部件顺序 |
| `docs/PRD.md:127-135` | 点击方格添加按钮就地打开添加面板；按 Esc 或点击面板外关闭 | 与抽屉形态冲突 | 改写为右侧抽屉，写明遮罩、Esc、Tab 循环 |
| `docs/PRD.md:188` | 子待办明细在卡片展开后显示 | 明细移入抽屉 | 改写为卡片显示进度 n/m，明细在抽屉内 |
| `docs/PRD-v2.md:412`、`446`、`479` | 「添加面板与编辑面板」措辞 | 与抽屉相容 | 补一条几何与键盘条款 |
| `docs/PRD-v2.md:792`（验收 74） | Tab 可到达卡片操作按钮 | 依赖 `.tc-card-actions` 的 `visibility` 修复 | 修复后才能判通过 |
| `tests/ui-layout.mjs:509-536` | 1720 视口断言已改为「每格卡片逐行向下排成一列」 | 与冻结口径一致 | 已同步 |
| `tests/ui-layout.mjs:542-548` | 900 视口保持外层两列 | 与单列卡片不冲突 | 不改 |
| `tests/ui-layout.mjs:550-560` | 680 视口外层改纵向单列 | 不改 | 不改 |
| `tests/ui-layout.mjs:478-486` | 卡片过渡时长非 0 | 悬浮改为覆盖层后仍需过渡声明 | 实现侧保持 `transition` |
| `tests/ui-layout.mjs:435-443` | 方格左缘 4 像素、卡片左缘 3 像素及颜色 | 与 44 像素行相容 | 实现侧保持 `border-left:3px` 与 56% 混色 |
| `tests/ui-layout.mjs:468-475` | 逾期 1 像素红色描边、逾期天数徽标 | 倒计时文案「逾期 N 天」满足徽标正则，样例为 2 天前 | 不改；样例改为 1 小时内会落到「逾期 N 分钟」 |
| `tests/ui-check-edit.mjs:24` | 作用域先取 `.tc-modal`，回退 `.tc-editor` | 抽屉保留 `.tc-modal` | 已兼容 |
| `tests/ui-check-v11.mjs:182-190` | 以 `.tc-editor` 等待添加面板、定位子待办输入 | 抽屉内字段区容器仍带 `.tc-editor`（L1057、字段组件根节点） | 已兼容；该类名与内联表单语义脱钩，需在规范里注明它现在指抽屉字段区 |
| `tests/ui-check.mjs:275` | 抽屉内 `.tc-child .tc-child-title` | 已迁移到抽屉作用域 | 已同步 |
| `tests/ui-check-v2.mjs:667` | 作用域候选含 `.tc-editor` 与 `[role="dialog"]` | 两者都能命中 | 已兼容 |

`tests/ui-check-cards.mjs` 已覆盖：C1 同一左边缘、C2 逐行向下、C3 行高 44、C4 宽度等于内容区、C5 纵向单列容器、C6 内容区无内联表单、C7 倒计时右边缘、C8 间距 8 至 14 像素、C9 文案分档、C10 滚动标记、C11 添加按钮、C12 抽屉占满高度并贴右、C13 宽度 420、C14 标题、C15 九个字段、C16 主按钮在视口内、C17 打开抽屉后卡片区高度不变、C18 Esc 与焦点返回、C19 遮罩关闭、C20 悬浮不改变行高、C21 悬浮层覆盖倒计时、C22 脚本无异常、C23 数据复原。

### 5.1 尚未被任何检查项覆盖的口径

1. 行高 44 的判定与 §2 表格第一行的 `box-sizing` 缺口直接相关：C3 断言五个卡片高度都等于 44，content-box 下读数为 45。检查项本身正确，需要实现侧补 `box-sizing:border-box`。
2. 键盘可达性：无检查项验证 Tab 能到达「更多操作」与「发起会话」，也无检查项验证 Tab 与 Shift+Tab 在抽屉首尾相接、焦点不在抽屉内时被拉回。
3. 倒计时边界：C9 只覆盖「今年内月日」一档。跨年、日差 7、不足 1 小时、无截止、已完成这五类没有检查项。
4. 窄视口抽屉：C13 只在宽于 1024 像素时取值，`92vw` 分支没有检查项。
5. 表单完整可视：C16 只验证主按钮落在视口内，没有逐字段验证矩形都在面板内，也没有验证字段区不出现横向溢出。
6. 格头固定：无检查项在滚动内容区后比较格头位置。
7. 1 像素内阴影：C10 只验证 `data-tc-scrolled` 标记，没有验证阴影值与 1 像素口径一致。
8. 主题对比度：无检查项在浅色与暗色下读取逾期文字的计算颜色并计算比值。
9. 逾期描边与选中、高亮共存：无检查项在高亮期间读取逾期卡片的 `border-top-color`。

## 6 倒计时七段文案的边界口径

### 6.1 判定顺序与取值

| 顺序 | 条件 | 文案 | 示例 | 依据 |
| --- | --- | --- | --- | --- |
| 1 | `dueAt` 为空或无法解析 | 未安排 | 未安排 | `dueTime` 返回空（L306-310）、L374 |
| 2 | `minuteOf(due) < minuteOf(now)` | 逾期 N 分钟、逾期 N 小时、逾期 N 天 | 逾期 40 分钟、逾期 3 小时、逾期 2 天 | L341-345、L361-368、L375 |
| 3 | 日历日差 0 | 今天 HH:mm | 今天 18:30 | L377-378 |
| 4 | 日历日差 1 | 明天 HH:mm | 明天 10:00 | L379 |
| 5 | 日历日差 2 至 6 | 周X HH:mm | 周三 14:00 | L380、L387-391 |
| 6 | 日历日差 7 起且同年 | MM-DD HH:mm | 11-05 14:00 | L381-383 |
| 7 | 跨年 | YYYY-MM-DD HH:mm | 2027-01-03 14:00 | L384 目前只输出日期（`formatDay`，L330-334），缺时刻 |

### 6.2 边界判定与取值依据

1. 逾期与今天的分界：按分钟比较，截止时刻等于当前分钟按未逾期处理（L340-345）。因此「今天 09:00」在 09:01 显示「逾期 1 小时」。
2. 小时与天的分界：按经过小时数切分，不足 24 小时用小时，24 小时起用天（L364-368）。逾期 23 小时 59 分显示「逾期 23 小时」，满 24 小时显示「逾期 1 天」。
3. 七段之外的一种形态：不足 1 小时的逾期输出「逾期 N 分钟」（L365）。冻结口径只列了小时与天两种量纲。建议把「逾期 N 分钟」补入口径：逾期判定精确到分钟，把 1 分钟与 59 分钟都写成「逾期 1 小时」会与徽标文案矛盾。若要严格保持七种，把该分支并入小时段并取 `Math.max(1, floor(minutes/60))`，一处改动。
4. 七天段与今天同名的边界：日历日差为 7 时星期与今天相同，「周三 14:00」会被读成今天或本周。星期段取 2 至 6，日差 7 起归入月日段。
5. 跨年段的时刻：口径对第 6 段写明「加时刻」，第 7 段写明「完整日期」。同列出现有时刻与无时刻两种形态会破坏右边齐平，建议第 7 段也带时刻，宽度核算见 §1.3。
6. 已完成的边界：四象限只渲染 `status==='open'` 的顶层条目（`quadrantLists`，L1464-1476），已完成条目不在四象限出现；已完成清单用「截止」与「完成」两列 `formatMoment`（L3747-3750），不套用七段。`isOverdue` 对非 open 条目直接返回假（L342），七段不承担已完成语义。
7. 零点和跨年夜：`now` 每 60 秒刷新（L1353-1356），日差随本地零点翻转；验收 44 的「60 秒内移动到今天到期」由同一只时钟保证。

### 6.3 对比度取值

卡片背景取 `bg-layer-2`（浅色 `#ffffff`，暗色 `#2c2c2e`）。

| 用途 | 浅色取值与比值 | 暗色取值与比值 | 结论 |
| --- | --- | --- | --- |
| 倒计时常规文字 `label-secondary` | `#61666b`，5.80 | `#cfd3d6`，9.25 | 通过 |
| 逾期文字原生 `state-error` | `#ec1313`，4.50 | `#f25a5a`，4.24 | 暗色不通过 |
| 逾期文字 88% 混 `label-primary` | `#D11313`，5.51 | `#F36D6D`，4.79 | 通过 |
| 标题文字 `label-primary` | `#0f1115`，18.90 | `#f9fafb`，13.34 | 通过 |
| 象限强调色 56% 混 `label-primary`（左缘 3 像素与 6 像素圆点） | `#8B1214` 9.57、`#90600F` 5.43、`#2B4A8A` 8.57、`#7D7E80` 4.06 | `#F5A0A1` 6.92、`#F7C675` 8.82、`#B2CDFD` 8.66、`#9D9E9F` 5.19 | 非文本图形，阈值 3:1，四个象限均通过 |

比值按 WCAG 相对亮度公式计算，脚本为 `D:\Workspace\Aika2 DevSpace\tmp\ux3-contrast.ps1`，可重跑。令牌取值取自 `dsh-client-ui-theme`。

## 7 风险登记

| 编号 | 位置 | 触发条件 | 影响 | 验证方式 |
| --- | --- | --- | --- | --- |
| G1 | `lib/client.js:1020` `.tc-card` | 未设 `box-sizing:border-box` | 渲染高度 45 像素，C3 的行高断言不通过 | 读 `getBoundingClientRect().height` 或运行 C3 |
| G2 | `lib/client.js:1034`、`1037` | 卡片带 2 个标签与 4 个标记，方格较窄 | 标题被压缩到 1 至 2 个字 | 1180 视口构造满标记卡片，量标题宽度不低于 96 |
| G3 | `lib/client.js:1043`、`1048` | 暗色主题下的逾期文字与会话错误文字 | 对比度 4.24，低于 12 像素文字的 4.5 | 取计算颜色算比值 |
| G4 | `lib/client.js:1014` | 内容区出现滚动 | 顶部提示是 8 像素模糊阴影，与 1 像素内阴影口径不一致 | 断言 `box-shadow` 含 `1px` |
| G5 | `lib/client.js:1024`、`1025` | 逾期卡片进入选中或高亮状态 | 上、右、下 1 像素错误色描边被 `border-color` 简写覆盖，逾期状态在 2 秒内看不出来 | 高亮期间读 `border-top-color` |
| G6 | `lib/client.js:1044` | 键盘用户按 Tab | 操作按钮在 `visibility:hidden` 子树内无法聚焦，验收 74 不通过 | 从标题按钮连续按 Tab，检查焦点到达「更多操作」 |
| G7 | `lib/client.js:377-384` | 日历日差为 7，或截止时间在次年 | 同一天出现「今天」与同名星期两种含义；跨年段缺时刻，与第 6 段形态不一致 | 用日差 7 与次年的固定数据断言文案 |
| G8 | `lib/client.js:365` | 逾期不足 1 小时 | 出现口径未列的第 8 种文案 | 用 10 分钟前的截止时间断言文案 |
| G9 | `lib/client.js:3609-3631` | 焦点在抽屉内但不在任一可聚焦项（点击抽屉空白后按 Tab） | 焦点跑到背后页面 | 点击抽屉标题空白处后按 Tab，检查焦点仍在抽屉内 |
| G10 | `lib/client.js:1083`、`1079` | 抽屉滚动到边界后继续滚轮 | 滚动链传给文档，背后页面跟随移动 | 在抽屉底部继续滚动，读 `.tc-shell` 的 `scrollTop` |

## 8 未执行与限制

1. 浏览器套件（`tests/ui-layout.mjs`、`tests/ui-check-cards.mjs`、`tests/ui-check-edit.mjs`、`tests/ui-check-v11.mjs`、`tests/ui-check.mjs`、`tests/measure-layout.mjs`）未执行：本次任务期间无独占浏览器与端口，运行会与并发写入冲突。以上判定来自源码、现有断言文本与算术，实测由验收角色完成。
2. 浅色与暗色主题的运行时取值未实测：比值按令牌取值计算，令牌来源为 `dsh-client-ui-theme`；令牌在 2.0 调整后需要重算。
3. 104 像素列的容纳结论为字体度量估算，未量取 `scrollWidth`。
4. `lib/client.js` 与 `tests/` 在本次分析期间被并发修改（快照 4095 行与 365 行），行号可能移动；引用处均带选择器、函数名或检查项名称。
