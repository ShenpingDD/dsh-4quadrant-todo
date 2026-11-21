# Host 半规则验证

两个脚本直接加载 `lib/index.js` 的 `apply`，用真实 `node:http` 服务与真实文件系统驱动，数据目录经 `config.dataDir` 指向本目录下的 `.run/`，不读写 `%DSH_HOME%`，也不访问运行中的实例。

## 运行

```
node todo-center/tests/host-rules/verify-host-rules.mjs
node todo-center/tests/host-rules/verify-api-v2.mjs
```

规则项不通过时退出码为 1，全部通过为 0。输出逐条列出编号、依据条款、期望与实际取值。

```
$env:DONE_COUNT='2000'; node todo-center/tests/host-rules/measure-scale.mjs
```

`measure-scale.mjs` 接受 `OPEN_COUNT` 与 `DONE_COUNT` 两个环境变量，默认 1000 与 10000，输出文件大小与各接口 5 次的中位耗时。

## 覆盖范围

`verify-host-rules.mjs` 分三组：

- A 组（父子联动）：子待办字段继承、合并完成的确认、父任务与子待办共用完成时间、最后一个子待办触发自动完成、撤销后不再自动完成、级联删除、改象限带动子待办、子待办单独改象限被忽略、第二层与悬空父待办的拒绝。
- B 组（来源去重）：同来源条目重复加入、`sourceKey` 拼接格式、默认象限与工作区、来源类型与会话不同的区分、子待办不参与去重、已完成与已删除条目的再次加入、`/create` 绕过来源去重。
- C 组（版本与结构校验）：版本不认识、JSON 无法解析、顶层与字段结构、`collapsed` 结构、`dueAt` 与 `id` 与 `parentId` 的取值、首次读取建立空结构、残留临时文件、并发首次读取、并发写入串行、写入标记与 `content-type`、标题与描述长度、时间格式、未知标识、写入失败、外部改坏后的即时报错。

`verify-api-v2.mjs` 按接口分组，用例编号对应 `docs/api-v2.md` 第 10 节 A2-01 至 A2-32，另含 A2-33 至 A2-39 七条补充用例：截止时间为空的重复条目按完成时刻推进、删除重复链首条后链中条目保持可用、逾期多日从未提醒的条目补发一次提醒、新建省略提醒取设置项默认值、子待办的新字段保持恒定值、会话来源的待办拒绝提醒设置、状态与会话标记的结构校验。

每组用例的编号与 `docs/review/host-half.md` 第 3、4 节的缺陷编号对应。

## 说明

脚本启动时断言路由数量为 19。用例里写入的数据文件是校验器的输入样本（例如故意写坏的 JSON、重复标识、悬空父待办），用于判定载入校验是否生效。
