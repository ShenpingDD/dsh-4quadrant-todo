$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3080/plugins/dsh-todo-center'
$writeHeaders = @{ 'x-dsh-todo' = '1' }
$failures = New-Object System.Collections.Generic.List[string]
$checks = 0

function Check($label, $condition, $detail) {
    $script:checks = $script:checks + 1
    if ($condition) {
        Write-Output "PASS $label"
    }
    else {
        Write-Output "FAIL $label -> $detail"
        $script:failures.Add($label)
    }
}

function Post($path, $body, $withHeader) {
    $headers = @{}
    if ($withHeader) { $headers = $writeHeaders }
    $json = $body | ConvertTo-Json -Depth 8 -Compress
    return Invoke-RestMethod -Uri "$base$path" -Method Post -ContentType 'application/json' -Headers $headers -Body $json
}

function PostExpectError($path, $body, $withHeader) {
    try {
        $null = Post $path $body $withHeader
        return 0
    }
    catch {
        $response = $_.Exception.Response
        if ($null -eq $response) { return -1 }
        return [int]$response.StatusCode
    }
}

function Get-Snapshot {
    return (Invoke-RestMethod -Uri "$base/snapshot" -Method Get).value
}

# 清空残留：删除全部顶层待办
$initial = Get-Snapshot
foreach ($item in $initial.todos) {
    if ($item.parentId -eq $null) { $null = Post '/remove' @{ ids = @($item.id) } $true }
}

$now = (Get-Date)
$due = $now.AddDays(2).ToString('yyyy-MM-ddTHH:mm') + ':00' + $now.ToString('zzz')

# 1 创建父任务
$created = Post '/create' @{ title = '整理季度复盘'; description = "第一行`n第二行"; dueAt = $due; quadrant = 'urgent-important'; workspaceId = $null } $true
$parentId = $created.value.focusId
Check '创建父任务返回 focusId' ($parentId -ne $null) 'focusId 为空'

# 2 创建子待办
$child1 = (Post '/create' @{ title = '汇总数据'; parentId = $parentId } $true).value.focusId
$child2 = (Post '/create' @{ title = '写结论'; parentId = $parentId } $true).value.focusId
$snapshot = Get-Snapshot
$children = @($snapshot.todos | Where-Object { $_.parentId -eq $parentId })
Check '子待办数量为 2' ($children.Count -eq 2) "实际 $($children.Count)"
Check '子待办继承父任务象限' (@($children | Where-Object { $_.quadrant -eq 'urgent-important' }).Count -eq 2) '象限未继承'

# 3 父任务存在未完成子待办时直接完成应报错
$status = PostExpectError '/complete' @{ ids = @($parentId); includeChildren = $false } $true
Check '父任务带未完成子待办直接完成返回 400' ($status -eq 400) "状态码 $status"

# 4 完成一个子待办，父任务仍未完成
$null = Post '/complete' @{ ids = @($child1); includeChildren = $false } $true
$snapshot = Get-Snapshot
$parent = $snapshot.todos | Where-Object { $_.id -eq $parentId }
Check '完成一个子待办后父任务仍为 open' ($parent.status -eq 'open') "父任务状态 $($parent.status)"

# 5 完成最后一个子待办，父任务自动完成
$null = Post '/complete' @{ ids = @($child2); includeChildren = $false } $true
$snapshot = Get-Snapshot
$parent = $snapshot.todos | Where-Object { $_.id -eq $parentId }
$lastChild = $snapshot.todos | Where-Object { $_.id -eq $child2 }
Check '最后一个子待办完成后父任务自动完成' ($parent.status -eq 'done') "父任务状态 $($parent.status)"
Check '父任务完成时间取最后一个子待办的完成时间' ($parent.completedAt -eq $lastChild.completedAt) "父 $($parent.completedAt) 子 $($lastChild.completedAt)"

# 6 撤销父任务完成，子待办仍为已完成，且不会再次自动完成
$null = Post '/reopen' @{ ids = @($parentId) } $true
$snapshot = Get-Snapshot
$parent = $snapshot.todos | Where-Object { $_.id -eq $parentId }
Check '撤销完成后父任务回到 open' ($parent.status -eq 'open' -and $parent.completedAt -eq $null) "状态 $($parent.status) 完成时间 $($parent.completedAt)"
Check '撤销父任务不改变子待办状态' (@($snapshot.todos | Where-Object { $_.parentId -eq $parentId -and $_.status -eq 'done' }).Count -eq 2) '子待办状态被改动'

# 7 折叠状态
$collapsed = (Post '/setCollapsed' @{ scopeKey = 'all'; quadrant = 'urgent-important'; collapsed = $true } $true).value.collapsed
Check '折叠状态写入成功' ($collapsed.all.'urgent-important' -eq $true) "返回值 $($collapsed | ConvertTo-Json -Compress)"
$collapsed = (Post '/setCollapsed' @{ scopeKey = 'all'; quadrant = 'urgent-important'; collapsed = $false } $true).value.collapsed
Check '折叠状态可以恢复' ($collapsed.all.'urgent-important' -eq $false) "返回值 $($collapsed | ConvertTo-Json -Compress)"

# 8 改象限，子待办跟随
$null = Post '/setQuadrant' @{ ids = @($parentId); quadrant = 'not-urgent-important' } $true
$snapshot = Get-Snapshot
Check '改象限后父任务与子待办都在新象限' (@($snapshot.todos | Where-Object { ($_.id -eq $parentId) -or ($_.parentId -eq $parentId) } | Where-Object { $_.quadrant -eq 'not-urgent-important' }).Count -eq 3) '象限未全部跟随'

# 9 来自会话的去重
$conversation = @{ sessionId = 'session-check-1'; entryType = 'question'; entryId = 'call-check-1'; title = '确认是否合并分支'; description = '选项 A 合并，选项 B 暂缓'; workspaceId = $null }
$first = (Post '/fromConversation' $conversation $true).value
$second = (Post '/fromConversation' $conversation $true).value
Check '首次从会话加入返回 existing=false' ($first.existing -eq $false) "existing=$($first.existing)"
Check '重复加入返回 existing=true 且标识相同' ($second.existing -eq $true -and $second.focusId -eq $first.focusId) "existing=$($second.existing) id=$($second.focusId)"
$snapshot = Get-Snapshot
Check '重复加入没有产生第二条记录' (@($snapshot.todos | Where-Object { $_.sourceKey -eq 'session-check-1:call-check-1:question' }).Count -eq 1) '出现重复记录'

# 10 级联删除
$null = Post '/remove' @{ ids = @($parentId) } $true
$snapshot = Get-Snapshot
Check '删除父任务后子待办一并消失' (@($snapshot.todos | Where-Object { $_.id -eq $parentId -or $_.parentId -eq $parentId }).Count -eq 0) '仍有残留'

# 11 错误场景
$status = PostExpectError '/create' @{ title = '缺写入头'; quadrant = 'urgent-important' } $false
Check '缺少 x-dsh-todo 请求头返回 403' ($status -eq 403) "状态码 $status"
$status = PostExpectError '/create' @{ title = '   '; quadrant = 'urgent-important' } $true
Check '空标题返回 400' ($status -eq 400) "状态码 $status"
$status = PostExpectError '/create' @{ title = '象限非法'; quadrant = 'whatever' } $true
Check '非法象限返回 400' ($status -eq 400) "状态码 $status"
$status = PostExpectError '/create' @{ title = '时区缺失'; quadrant = 'urgent-important'; dueAt = '2026-11-05T23:59' } $true
Check '截止时间缺时区返回 400' ($status -eq 400) "状态码 $status"
$status = PostExpectError '/create' @{ title = '父待办不存在'; quadrant = 'urgent-important'; parentId = 't_not_exist' } $true
Check '父待办不存在返回 400' ($status -eq 400) "状态码 $status"

# 清场
$final = Get-Snapshot
foreach ($item in $final.todos) {
    if ($item.parentId -eq $null) { $null = Post '/remove' @{ ids = @($item.id) } $true }
}
$after = Get-Snapshot
Check '清场后待办数量为 0' ($after.todos.Count -eq 0) "剩余 $($after.todos.Count)"

Write-Output "----"
Write-Output "共 $checks 项，失败 $($failures.Count) 项"
if ($failures.Count -gt 0) {
    foreach ($name in $failures) { Write-Output "未通过: $name" }
    exit 1
}
exit 0
