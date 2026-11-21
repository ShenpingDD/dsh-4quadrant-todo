window.__ModuleLoader__.load({
  id: 'dsh-4quadrant-todo',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore } = React

    const ROUTE = '/plugins/dsh-4quadrant-todo'
    const PANEL_ID = 'four-quadrant-todo'
    const WRITE_HEADERS = { 'content-type': 'application/json', 'x-dsh-todo': '1' }
    const POLL_INTERVAL = 30000
    const REMINDER_LIMIT = 50
    const QUICK_MAX = 200

    // 栅格顺序：左上、右上、左下、右下
    const QUADRANTS = [
      { id: 'urgent-important', name: '紧急且重要', emoji: '🔥', level: '立刻处理' },
      { id: 'not-urgent-important', name: '重要不紧急', emoji: '⛳', level: '排入计划' },
      { id: 'urgent-not-important', name: '紧急不重要', emoji: '⛰️', level: '尽快处理' },
      { id: 'not-urgent-not-important', name: '不重要不紧急', emoji: '🛶', level: '有空再做' }
    ]

    const QUADRANT_NAME = new Map(QUADRANTS.map((item) => [item.id, item.name]))
    const QUADRANT_IDS = QUADRANTS.map((item) => item.id)

    // 快速录入里的象限标记
    const QUADRANT_MARKERS = new Map([
      ['紧急重要', 'urgent-important'],
      ['重要紧急', 'urgent-important'],
      ['重要', 'not-urgent-important'],
      ['紧急', 'urgent-not-important'],
      ['一般', 'not-urgent-not-important'],
      ['不紧急不重要', 'not-urgent-not-important']
    ])

    const TABS = [
      { id: 'quadrants', label: '四象限' },
      { id: 'today', label: '今日' },
      { id: 'completed', label: '已完成' },
      { id: 'stats', label: '统计' }
    ]

    const TODAY_SECTIONS = [
      { id: 'overdue', name: '已逾期', open: true },
      { id: 'today', name: '今天到期', open: true },
      { id: 'next7', name: '未来 7 天', open: true },
      { id: 'later', name: '更晚', open: false },
      { id: 'unscheduled', name: '未安排', open: true }
    ]

    const REMINDER_OPTIONS = [
      { value: 'none', label: '不提醒' },
      { value: '0', label: '准时' },
      { value: '5', label: '提前 5 分钟' },
      { value: '15', label: '提前 15 分钟' },
      { value: '30', label: '提前 30 分钟' },
      { value: '60', label: '提前 1 小时' },
      { value: '1440', label: '提前 1 天' }
    ]

    const FREQ_OPTIONS = [
      { value: '', label: '不重复' },
      { value: 'daily', label: '按天' },
      { value: 'weekly', label: '按周' },
      { value: 'monthly', label: '按月' }
    ]

    const FREQ_UNIT = { daily: '天', weekly: '周', monthly: '个月' }

    const STATS_RANGES = [
      { id: 'week', label: '本周' },
      { id: 'month', label: '本月' },
      { id: 'quarter', label: '近 90 天' },
      { id: 'custom', label: '自定义' }
    ]

    const PERIOD_HOUR = { 上午: 9, 中午: 12, 下午: 14, 傍晚: 18, 晚上: 20 }
    const WEEKDAY_INDEX = new Map([['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['日', 7], ['天', 7]])

    const runtime = { ctx: null }

    // ---------- 模块级共享数据 ----------

    const store = {
      todos: [],
      collapsed: {},
      filters: [],
      settings: { reminderLeadMinutes: 30, statsRange: 'week' },
      meta: { upgradedAt: null, upgradedFrom: null },
      readOnly: false,
      dataVersion: 2,
      loaded: false,
      loading: false,
      pendingWrites: 0,
      error: null,
      reminders: [],
      reminderCount: 0,
      reminderError: null,
      reminderOverlay: null,
      listeners: new Set(),
      snapshot: null
    }

    store.snapshot = buildSnapshot()

    function buildSnapshot() {
      return {
        todos: store.todos,
        collapsed: store.collapsed,
        filters: store.filters,
        settings: store.settings,
        meta: store.meta,
        readOnly: store.readOnly,
        dataVersion: store.dataVersion,
        loaded: store.loaded,
        loading: store.loading,
        error: store.error,
        reminders: store.reminders,
        reminderCount: store.reminderCount,
        reminderOverlay: store.reminderOverlay
      }
    }

    function publish() {
      store.snapshot = buildSnapshot()
      for (const listener of store.listeners) listener()
    }

    function subscribeStore(listener) {
      store.listeners.add(listener)
      return () => {
        store.listeners.delete(listener)
      }
    }

    function getStoreSnapshot() {
      return store.snapshot
    }

    function useStore() {
      return useSyncExternalStore(subscribeStore, getStoreSnapshot, getStoreSnapshot)
    }

    let pendingFocusId = null
    let pendingTab = null

    function requestFocus(id) {
      pendingFocusId = id
      publish()
    }

    function requestTab(tab) {
      pendingTab = tab
      publish()
    }

    function dismissReminderOverlay() {
      if (store.reminderOverlay === null) return
      store.reminderOverlay = null
      publish()
    }

    function clearError() {
      if (store.error === null) return
      store.error = null
      publish()
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    // ---------- 接口调用 ----------

    async function call(path, body) {
      const options = body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: WRITE_HEADERS, body: JSON.stringify(body) }
      const response = await fetch(`${ROUTE}${path}`, options)
      const payload = await response.json()
      if (payload.ok !== true) throw new Error(payload.error ?? `请求失败 ${response.status}`)
      return payload.value
    }

    // 写入成功后按增量合并本地副本
    function applyDelta(value) {
      const byId = new Map(store.todos.map((item) => [item.id, item]))
      for (const id of value.removedIds ?? []) byId.delete(id)
      for (const item of value.upserted ?? []) byId.set(item.id, item)
      store.todos = [...byId.values()]
      if (Array.isArray(value.collapsed) === false && value.collapsed !== undefined) store.collapsed = value.collapsed
      if (Array.isArray(value.filters)) store.filters = value.filters
    }

    async function loadSnapshot() {
      // 写入进行中不读取，避免把还没反映写入结果的数据盖到本地副本上
      if (store.loading || store.pendingWrites > 0) return
      store.loading = true
      store.error = null
      publish()
      try {
        const value = await call('/snapshot')
        store.todos = value.todos ?? []
        store.collapsed = value.collapsed ?? {}
        store.filters = Array.isArray(value.filters) ? value.filters : []
        store.settings = value.settings ?? { reminderLeadMinutes: 30, statsRange: 'week' }
        store.meta = value.meta ?? { upgradedAt: null, upgradedFrom: null }
        store.readOnly = value.readOnly === true
        store.dataVersion = typeof value.dataVersion === 'number' ? value.dataVersion : 1
        store.loaded = true
      } catch (error) {
        store.error = messageOf(error)
      } finally {
        store.loading = false
        publish()
      }
    }

    // 静默同步一次数据文件内容，还没关闭的提示保留在页面上
    async function refreshData() {
      const message = store.error
      await loadSnapshot()
      if (message !== null && store.error === null) {
        store.error = message
        publish()
      }
    }

    async function loadReminders() {
      try {
        const value = await call('/reminders')
        store.reminders = Array.isArray(value.items) ? value.items : []
        store.reminderCount = store.readOnly === true ? 0 : (typeof value.count === 'number' ? value.count : 0)
        store.reminderError = null
        publish()
      } catch (error) {
        store.reminderError = messageOf(error)
        console.error('[dsh-4quadrant-todo] reminders:', messageOf(error))
      }
    }

    async function runWrite(operation) {
      store.pendingWrites += 1
      let missingTodo = null
      try {
        const value = await operation()
        applyDelta(value)
        store.error = null
        publish()
        return value
      } catch (error) {
        const message = messageOf(error)
        store.error = message
        publish()
        if (message.startsWith('待办不存在') || message.startsWith('父待办不存在')) missingTodo = message
        return null
      } finally {
        store.pendingWrites -= 1
        // 卡片对应的待办已在别处被删除或替换时，按文件内容重新读取一次，列表回到真实内容
        if (missingTodo !== null) {
          await loadSnapshot()
          store.error = missingTodo
          publish()
        }
      }
    }

    // ---------- 时间处理 ----------

    function pad(value) {
      return String(value).padStart(2, '0')
    }

    function offsetOf(date) {
      const minutes = -date.getTimezoneOffset()
      const sign = minutes < 0 ? '-' : '+'
      const abs = Math.abs(minutes)
      return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
    }

    // 把本机无时区的值补上时区标识；时刻可写 HH:mm 或 HH:mm:ss，秒位只补一次，格式不合规抛出错误
    function toIso(localValue, endOfDay) {
      if (localValue === '' || localValue === null || localValue === undefined) return null
      const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(localValue))
      if (match === null) throw new Error('截止时间格式不正确')
      const year = Number(match[1])
      const month = Number(match[2])
      const day = Number(match[3])
      const hasTime = match[4] !== undefined
      const hour = hasTime ? Number(match[4]) : (endOfDay ? 23 : 0)
      const minute = hasTime ? Number(match[5]) : (endOfDay ? 59 : 0)
      const second = match[6] === undefined ? 0 : Number(match[6])
      const date = new Date(year, month - 1, day, hour, minute, second)
      const mismatched = date.getFullYear() !== year
        || date.getMonth() !== month - 1
        || date.getDate() !== day
        || date.getHours() !== hour
        || date.getMinutes() !== minute
        || date.getSeconds() !== second
      if (mismatched) throw new Error('截止时间格式不正确')
      return `${match[1]}-${match[2]}-${match[3]}T${pad(hour)}:${pad(minute)}:${pad(second)}${offsetOf(date)}`
    }

    function isoFromLocal(date, hour, minute) {
      const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      const timePart = `${pad(hour)}:${pad(minute)}`
      return `${datePart}T${timePart}:00${offsetOf(new Date(`${datePart}T${timePart}:00`))}`
    }

    function toLocalInput(iso) {
      if (iso === null || iso === undefined) return ''
      const date = new Date(iso)
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function dateInputOf(iso) {
      if (iso === null || iso === undefined) return ''
      const date = new Date(iso)
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    function timeInputOf(iso) {
      if (iso === null || iso === undefined) return ''
      const date = new Date(iso)
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function dueTime(item) {
      if (item.dueAt === null || item.dueAt === undefined) return null
      const time = Date.parse(item.dueAt)
      return Number.isNaN(time) ? null : time
    }

    function completedTime(item) {
      if (item.completedAt === null || item.completedAt === undefined) return null
      const time = Date.parse(item.completedAt)
      return Number.isNaN(time) ? null : time
    }

    function formatMoment(iso) {
      if (iso === null || iso === undefined || iso === '') return '—'
      const date = new Date(iso)
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function formatClock(iso) {
      if (iso === null || iso === undefined || iso === '') return '—'
      const date = new Date(iso)
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function formatDay(iso) {
      if (iso === null || iso === undefined || iso === '') return '—'
      const date = new Date(iso)
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    function minuteOf(time) {
      return Math.floor(time / 60000)
    }

    // 截止时间恰好等于当前分钟按未逾期处理
    function isOverdue(item, now) {
      if (item.status !== 'open') return false
      const time = dueTime(item)
      return time !== null && minuteOf(time) < minuteOf(now)
    }

    function overdueText(item, now) {
      const time = dueTime(item)
      if (time === null) return ''
      return overdueBadgeText(item, now)
    }

    // 卡片上的逾期徽标按天数取整，不足一天按小时与分钟显示
    function overdueBadgeText(item, now) {
      const time = dueTime(item)
      if (time === null) return ''
      const minutes = Math.floor((now - time) / 60000)
      if (minutes < 60) return `逾期 ${Math.max(minutes, 1)} 分钟`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `逾期 ${hours} 小时`
      return `逾期 ${Math.floor(hours / 24)} 天`
    }

    // 卡片右侧倒计时：逾期写已过多久，未到期按今天、明天、七天内、今年内、跨年分档
    function countdownText(item, now) {
      if (item.status !== undefined && item.status !== 'open') return '已完成'
      const time = dueTime(item)
      if (time === null) return '未安排'
      if (minuteOf(time) < minuteOf(now)) return overdueBadgeText(item, now)
      const target = new Date(time)
      const dayGap = Math.round((startOfToday(time) - startOfToday(now)) / 86400000)
      if (dayGap === 0) return `今天 ${formatClock(item.dueAt)}`
      if (dayGap === 1) return `明天 ${formatClock(item.dueAt)}`
      if (dayGap <= 7) return `${weekdayLabel(target)} ${formatClock(item.dueAt)}`
      if (target.getFullYear() === new Date(now).getFullYear()) {
        return `${pad(target.getMonth() + 1)}-${pad(target.getDate())} ${formatClock(item.dueAt)}`
      }
      return formatDay(item.dueAt)
    }

    function weekdayLabel(date) {
      const names = ['一', '二', '三', '四', '五', '六', '日']
      const index = date.getDay() === 0 ? 7 : date.getDay()
      return `周${names[index - 1]}`
    }

    function startOfToday(now) {
      const date = new Date(now)
      date.setHours(0, 0, 0, 0)
      return date.getTime()
    }

    function startOfWeek(now) {
      const date = new Date(now)
      const weekday = date.getDay() === 0 ? 7 : date.getDay()
      date.setHours(0, 0, 0, 0)
      date.setDate(date.getDate() - (weekday - 1))
      return date.getTime()
    }

    function startOfMonth(now) {
      const date = new Date(now)
      date.setHours(0, 0, 0, 0)
      date.setDate(1)
      return date.getTime()
    }

    function addDays(time, days) {
      const date = new Date(time)
      date.setDate(date.getDate() + days)
      return date.getTime()
    }

    function dateInputBoundary(value, endOfDay) {
      if (value === '' || value === undefined) return null
      const date = new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`)
      const time = date.getTime()
      return Number.isNaN(time) ? null : time
    }

    // ---------- 排序与筛选口径 ----------

    function compareTodos(left, right) {
      const leftDue = dueTime(left)
      const rightDue = dueTime(right)
      if (leftDue !== null && rightDue !== null && leftDue !== rightDue) return leftDue - rightDue
      if (leftDue !== null && rightDue === null) return -1
      if (leftDue === null && rightDue !== null) return 1
      return Date.parse(left.createdAt) - Date.parse(right.createdAt)
    }

    function scopeMatches(item, scopeKey) {
      if (scopeKey === 'all') return true
      if (scopeKey === 'none') return item.workspaceId === null
      return item.workspaceId === scopeKey
    }

    function matchesKeyword(item, keyword) {
      if (keyword === '') return true
      const text = keyword.toLowerCase()
      return item.title.toLowerCase().includes(text) || item.description.toLowerCase().includes(text)
    }

    function emptyConditions() {
      return {
        tags: [],
        quadrants: [],
        dueState: 'all',
        dueRange: { kind: 'any', from: null, to: null },
        source: 'all',
        keyword: ''
      }
    }

    function normalizeConditions(value) {
      const base = emptyConditions()
      const ranges = ['any', 'today', 'week', 'range']
      const dueStates = ['all', 'overdue', 'notOverdue', 'noDue']
      const sources = ['all', 'manual', 'conversation']
      if (value === null || typeof value !== 'object') return base
      return {
        tags: Array.isArray(value.tags) ? value.tags.filter((tag) => typeof tag === 'string') : [],
        quadrants: Array.isArray(value.quadrants) ? value.quadrants.filter((id) => QUADRANT_NAME.has(id)) : [],
        dueState: dueStates.includes(value.dueState) ? value.dueState : 'all',
        dueRange: value.dueRange !== null && typeof value.dueRange === 'object' && ranges.includes(value.dueRange.kind)
          ? {
            kind: value.dueRange.kind,
            from: typeof value.dueRange.from === 'string' ? value.dueRange.from : null,
            to: typeof value.dueRange.to === 'string' ? value.dueRange.to : null
          }
          : base.dueRange,
        source: sources.includes(value.source) ? value.source : 'all',
        keyword: typeof value.keyword === 'string' ? value.keyword.slice(0, 100) : ''
      }
    }

    function conditionsEqual(left, right) {
      const a = normalizeConditions(left)
      const b = normalizeConditions(right)
      return JSON.stringify(a) === JSON.stringify(b)
    }

    function matchesDueRange(item, range, now) {
      if (range.kind === 'any') return true
      const time = dueTime(item)
      if (time === null) return false
      if (range.kind === 'today') {
        const start = startOfToday(now)
        return time >= start && time < start + 86400000
      }
      if (range.kind === 'week') {
        const start = startOfWeek(now)
        return time >= start && time < addDays(start, 7)
      }
      const lower = dateInputBoundary(range.from, false)
      const upper = dateInputBoundary(range.to, true)
      if (lower === null || upper === null) return true
      return time >= lower && time <= upper
    }

    function matchesConditions(item, conditions, now) {
      if (conditions.tags.length > 0) {
        if (!conditions.tags.every((tag) => item.tags.includes(tag))) return false
      }
      if (conditions.quadrants.length > 0 && !conditions.quadrants.includes(item.quadrant)) return false
      if (conditions.source !== 'all' && item.source.kind !== conditions.source) return false
      if (!matchesKeyword(item, conditions.keyword)) return false
      const overdue = isOverdue(item, now)
      if (conditions.dueState === 'overdue' && !overdue) return false
      if (conditions.dueState === 'notOverdue' && overdue) return false
      if (conditions.dueState === 'noDue' && item.dueAt !== null) return false
      return matchesDueRange(item, conditions.dueRange, now)
    }

    function tagUsage(todos) {
      const map = new Map()
      for (const item of todos) {
        for (const tag of item.tags) map.set(tag, (map.get(tag) ?? 0) + 1)
      }
      return map
    }

    function tagCandidatesOf(todos, limit) {
      const map = tagUsage(todos)
      return [...map.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh'))
        .slice(0, limit)
        .map((entry) => entry[0])
    }

    function missingTagsOf(conditions, todos) {
      if (conditions.tags.length === 0) return []
      const map = tagUsage(todos)
      return conditions.tags.filter((tag) => !map.has(tag))
    }

    // ---------- 快速录入解析 ----------

    function parseDateWord(found, now) {
      const text = found[0]
      const today = new Date(startOfToday(now))
      if (text === '今天' || text === '今日') return datePartsOf(today)
      if (text === '明天' || text === '明日') return datePartsOf(new Date(addDays(today.getTime(), 1)))
      if (text === '后天') return datePartsOf(new Date(addDays(today.getTime(), 2)))
      if (text === '大后天') return datePartsOf(new Date(addDays(today.getTime(), 3)))
      const key = found[1] ?? found[2]
      const index = WEEKDAY_INDEX.get(key)
      if (index === undefined) return null
      const weekStart = new Date(startOfWeek(now))
      if (text.startsWith('下')) {
        return datePartsOf(new Date(addDays(weekStart.getTime(), 7 + index - 1)))
      }
      const target = new Date(addDays(weekStart.getTime(), index - 1))
      if (target.getTime() < today.getTime()) return datePartsOf(new Date(addDays(target.getTime(), 7)))
      return datePartsOf(target)
    }

    function datePartsOf(date) {
      return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }
    }

    function makeLocalDate(year, month, day) {
      const date = new Date(year, month - 1, day)
      if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
      return date
    }

    function numericDate(year, month, day) {
      const date = makeLocalDate(year, month, day)
      return date === null ? null : datePartsOf(date)
    }

    function applyPeriod(period, hour) {
      if (period === '上午') return hour === 12 ? 0 : hour
      if (period === '中午') return hour < 11 ? hour + 12 : hour
      if (period === '下午' || period === '傍晚' || period === '晚上') return hour < 12 ? hour + 12 : hour
      return hour
    }

    function parseTimeWord(found) {
      if (found[6] !== undefined) return { hour: PERIOD_HOUR[found[6]], minute: 0, periodOnly: true }
      if (found[4] !== undefined) {
        const hour = Number(found[4])
        const minute = Number(found[5])
        if (hour > 23 || minute > 59) return null
        return { hour, minute }
      }
      let hour = Number(found[2])
      if (hour > 23) return null
      let minute = 0
      if (found[3] === '半') minute = 30
      else if (found[3] !== undefined) minute = Number(found[3].replace('分', ''))
      if (Number.isNaN(minute) || minute > 59) return null
      const period = found[1]
      if (period !== undefined) hour = applyPeriod(period, hour)
      return { hour, minute }
    }

    function parseQuickInput(text, now) {
      const claims = []
      const tags = []
      let quadrant = 'urgent-important'
      let markerTaken = false

      function overlaps(start, end) {
        return claims.some((item) => start < item.end && end > item.start)
      }

      function claim(start, end, payload) {
        if (overlaps(start, end)) return false
        claims.push({ start, end, ...payload })
        return true
      }

      const tagPattern = /#([^\s#]+)/g
      let found = tagPattern.exec(text)
      while (found !== null) {
        const content = found[1]
        const start = found.index
        const end = start + found[0].length
        const target = QUADRANT_MARKERS.get(content)
        if (target !== undefined) {
          if (!markerTaken && claim(start, end, { kind: 'marker' })) {
            quadrant = target
            markerTaken = true
          }
        } else if (claim(start, end, { kind: 'tag' })) {
          if (!tags.includes(content)) tags.push(content)
        }
        found = tagPattern.exec(text)
      }

      const dateCandidates = []
      const timeCandidates = []

      function scan(pattern, collect, build) {
        pattern.lastIndex = 0
        let match = pattern.exec(text)
        while (match !== null) {
          const start = match.index
          const end = start + match[0].length
          if (!overlaps(start, end)) {
            const value = build(match)
            if (value !== null) collect.push({ start, end, value, text: match[0] })
          }
          match = pattern.exec(text)
        }
      }

      const currentYear = new Date(now).getFullYear()
      scan(/(\d{4})-(\d{1,2})-(\d{1,2})/g, dateCandidates, (match) => numericDate(Number(match[1]), Number(match[2]), Number(match[3])))
      scan(/(\d{1,2})月(\d{1,2})日?/g, dateCandidates, (match) => numericDate(currentYear, Number(match[1]), Number(match[2])))
      scan(/(\d{1,2})\/(\d{1,2})/g, dateCandidates, (match) => numericDate(currentYear, Number(match[1]), Number(match[2])))
      scan(/(\d{1,2})-(\d{1,2})/g, dateCandidates, (match) => numericDate(currentYear, Number(match[1]), Number(match[2])))
      scan(/大后天|后天|明天|明日|今天|今日|下(?:周|星期|礼拜)([一二三四五六日天])|(?:周|星期|礼拜)([一二三四五六日天])/g, dateCandidates, (match) => parseDateWord(match, now))
      // 捕获组 1 至 6：时段前缀、点前小时、点后分钟、冒号前小时、冒号后分钟、单独时段
      scan(/(上午|中午|下午|傍晚|晚上)?(\d{1,2})点(半|\d{1,2}分?)?|(\d{1,2}):(\d{2})|(上午|中午|下午|傍晚|晚上)/g, timeCandidates, (match) => parseTimeWord(match))

      dateCandidates.sort((left, right) => left.start - right.start)
      timeCandidates.sort((left, right) => left.start - right.start)

      const notes = []
      if (dateCandidates.length > 1 || timeCandidates.length > 1) notes.push('已取第一个时间')

      const acceptedDate = dateCandidates.length > 0 ? dateCandidates[0] : null
      const acceptedTime = timeCandidates.length > 0 ? timeCandidates[0] : null

      if (acceptedDate === null && acceptedTime === null) {
        notes.push('未识别截止时间')
      } else {
        if (acceptedDate !== null) claims.push({ start: acceptedDate.start, end: acceptedDate.end, kind: 'date' })
        if (acceptedTime !== null) claims.push({ start: acceptedTime.start, end: acceptedTime.end, kind: 'time' })
      }

      let dueAt = null
      if (acceptedDate !== null) {
        const date = makeLocalDate(acceptedDate.value.year, acceptedDate.value.month, acceptedDate.value.day)
        if (date !== null) {
          dueAt = acceptedTime === null
            ? isoFromLocal(date, 23, 59)
            : isoFromLocal(date, acceptedTime.value.hour, acceptedTime.value.minute)
        }
      } else if (acceptedTime !== null) {
        const today = new Date(startOfToday(now))
        const candidate = isoFromLocal(today, acceptedTime.value.hour, acceptedTime.value.minute)
        if (Date.parse(candidate) <= now) {
          const tomorrow = new Date(addDays(today.getTime(), 1))
          dueAt = isoFromLocal(tomorrow, acceptedTime.value.hour, acceptedTime.value.minute)
        } else {
          dueAt = candidate
        }
      }

      claims.sort((left, right) => left.start - right.start)
      let title = ''
      let cursor = 0
      for (const item of claims) {
        title += text.slice(cursor, item.start)
        cursor = item.end
      }
      title += text.slice(cursor)

      return {
        title: title.replace(/\s+/g, ' ').trim(),
        dueAt,
        quadrant,
        tags,
        matched: claims.map((item) => text.slice(item.start, item.end)),
        notes
      }
    }

    // ---------- 统计口径 ----------

    function statsBounds(kind, fromValue, toValue, now) {
      if (kind === 'week') return { from: startOfWeek(now), to: now }
      if (kind === 'month') return { from: startOfMonth(now), to: now }
      if (kind === 'quarter') return { from: addDays(startOfToday(now), -89), to: now }
      const from = dateInputBoundary(fromValue, false)
      const to = dateInputBoundary(toValue, true)
      if (from === null || to === null) return { error: '请选择开始日期与结束日期' }
      if (from > to) return { error: '开始日期不能晚于结束日期' }
      return { from, to }
    }

    function emptyQuadrantCounts() {
      const counts = {}
      for (const id of QUADRANT_IDS) counts[id] = 0
      return counts
    }

    function percentOf(count, total) {
      if (total === 0) return null
      return Math.round((count / total) * 1000) / 10
    }

    // 最大余数法把一组计数补齐到合计 100%
    function percentList(counts) {
      const total = counts.reduce((sum, value) => sum + value, 0)
      if (total === 0) return counts.map(() => null)
      const raw = counts.map((value) => (value * 1000) / total)
      const units = raw.map((value) => Math.floor(value))
      let rest = 1000 - units.reduce((sum, value) => sum + value, 0)
      const order = raw
        .map((value, index) => ({ index, diff: value - units[index] }))
        .sort((left, right) => right.diff - left.diff)
      let cursor = 0
      while (rest > 0) {
        units[order[cursor % order.length].index] += 1
        rest -= 1
        cursor += 1
      }
      return units.map((value) => value / 10)
    }

    function computeStats(options) {
      const { todos, now, scopeKey, kind, fromValue, toValue } = options
      const bounds = statsBounds(kind, fromValue, toValue, now)
      if (bounds.error !== undefined) return { error: bounds.error }
      const from = bounds.from
      const to = bounds.to

      const openByQuadrant = emptyQuadrantCounts()
      const doneByQuadrant = emptyQuadrantCounts()
      let doneCount = 0
      let overdueNumerator = 0
      let overdueDenominator = 0
      let openOverdueCount = 0

      for (const item of todos) {
        if (item.parentId !== null) continue
        if (!scopeMatches(item, scopeKey)) continue
        if (item.status === 'open') {
          openByQuadrant[item.quadrant] += 1
          if (isOverdue(item, now)) openOverdueCount += 1
          continue
        }
        const finished = completedTime(item)
        if (finished === null || finished < from || finished > to) continue
        doneCount += 1
        doneByQuadrant[item.quadrant] += 1
        const due = dueTime(item)
        if (due !== null) {
          overdueDenominator += 1
          if (finished > due) overdueNumerator += 1
        }
      }

      const weekCount = 8
      const weeklyDone = []
      const thisWeek = startOfWeek(now)
      for (let index = weekCount - 1; index >= 0; index -= 1) {
        const weekStart = addDays(thisWeek, -index * 7)
        const weekEnd = addDays(weekStart, 7)
        const lower = weekStart < from ? from : weekStart
        const upper = weekEnd > to ? to : weekEnd
        let count = 0
        if (lower < upper) {
          for (const item of todos) {
            if (item.parentId !== null || item.status !== 'done') continue
            if (!scopeMatches(item, scopeKey)) continue
            const finished = completedTime(item)
            if (finished === null) continue
            if (finished >= lower && finished < upper) count += 1
          }
        }
        weeklyDone.push({ weekStart, count })
      }

      const openTotal = QUADRANT_IDS.reduce((sum, id) => sum + openByQuadrant[id], 0)
      const doneTotal = QUADRANT_IDS.reduce((sum, id) => sum + doneByQuadrant[id], 0)

      return {
        from,
        to,
        doneCount,
        overdueNumerator,
        overdueDenominator,
        openByQuadrant,
        doneByQuadrant,
        openPercent: percentList(QUADRANT_IDS.map((id) => openByQuadrant[id])),
        donePercent: percentList(QUADRANT_IDS.map((id) => doneByQuadrant[id])),
        openTotal,
        doneTotal,
        openOverdueCount,
        weeklyDone
      }
    }

    // ---------- 样式表 ----------

    const STYLE_TEXT = `
.tc-root{display:flex;flex-direction:column;height:100%;min-height:0}
.tc-page{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;container-type:inline-size;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;--tc-dur-fast:120ms;--tc-dur-base:180ms;--tc-ease:cubic-bezier(.2,.7,.3,1)}

/* 页面骨架 */
.tc-shell{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;width:100%;box-sizing:border-box;padding:0 clamp(12px,1.2vw,24px) clamp(8px,1vh,16px);overflow:hidden}
.tc-tabpanel{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;min-width:0;animation-duration:140ms;animation-timing-function:var(--tc-ease);animation-fill-mode:both}
/* 每个页签用不同的动画名，切换页签时动画重新开始，子节点状态不丢失 */
.tc-tabpanel[data-tc-tab="quadrants"]{animation-name:tc-fade-quadrants}
.tc-tabpanel[data-tc-tab="today"]{animation-name:tc-fade-today}
.tc-tabpanel[data-tc-tab="completed"]{animation-name:tc-fade-completed}
.tc-tabpanel[data-tc-tab="stats"]{animation-name:tc-fade-stats}
.tc-header{display:flex;align-items:center;gap:12px;flex:0 0 auto;padding:12px 0}
.tc-title{flex:0 0 auto;font:var(--dsw-font-l-20);color:var(--dsw-alias-label-primary)}
.tc-spacer{flex:1 1 auto}
.tc-header-spacer{flex:1 1 auto}

/* 标签行与工具菜单 */
.tc-tabs-row{display:flex;align-items:flex-end;gap:8px;flex:0 0 auto;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.tc-tabs{display:flex;gap:24px;flex:1 1 auto;min-width:0}
.tc-tab{padding:4px 0 8px;background:none;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-s-14);cursor:pointer}
.tc-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}
.tc-tools-wrap{position:relative;flex:0 0 auto;padding-bottom:4px}
.tc-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:26;display:flex;flex-direction:column;min-width:176px;padding:4px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-shadow-lv3)}
.tc-menu-item{display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;background:none;border:0;border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);text-align:left;cursor:pointer}
.tc-menu-item:hover,.tc-menu-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.tc-menu-item:disabled{color:var(--dsw-alias-label-secondary);cursor:default}
.tc-menu-note{padding:4px 10px 6px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-11)}

/* 状态条 */
.tc-banner{display:flex;align-items:center;gap:8px;flex:0 0 auto;min-height:36px;margin:8px 0 0;padding:6px 10px;border-radius:var(--dsw-radius-sm);font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary)}
.tc-banner-text{flex:1 1 auto;min-width:0;white-space:pre-wrap}
.tc-banner-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto}
.tc-banner-info{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2)}
.tc-banner-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,var(--dsw-alias-bg-layer-1));border:.5px solid var(--dsw-alias-border-l2);border-left:3px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 42%,var(--dsw-alias-label-primary))}
.tc-banner-error{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-state-error-primary)}

/* 通用控件 */
.tc-select{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);padding:3px 6px;font:inherit;max-width:220px}
.tc-select:disabled{opacity:.55;cursor:default}
.tc-input{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);padding:4px 8px;font:inherit;min-width:0}
.tc-input::placeholder{color:var(--dsw-alias-label-secondary)}
.tc-input:disabled{opacity:.55;cursor:default}
.tc-input:focus,.tc-select:focus{border-color:var(--dsw-focus-ring-color)}
.tc-input:focus-visible,.tc-select:focus-visible,.tc-button:focus-visible,.tc-tab:focus-visible,.tc-link:focus-visible,.tc-card-title-button:focus-visible,.tc-menu-item:focus-visible,.tc-pop-row:focus-visible,.tc-preset-row:focus-visible,.tc-section-head:focus-visible,.tc-quick-help:focus-visible,.tc-seg-btn:focus-visible,.tc-tag-x:focus-visible,.tc-icon-button:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.tc-textarea{min-height:64px;resize:vertical;font-family:inherit}
.tc-button{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);padding:4px 10px;font:inherit;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:4px}
.tc-button:hover{background:var(--dsw-alias-bg-layer-2)}
.tc-button:disabled{opacity:.45;cursor:default}
.tc-button-small{height:24px;padding:0 8px;font:var(--dsw-font-xxs-12)}
.tc-button-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.tc-button-primary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,#000);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,#000);transform:translateY(-1px)}
.tc-link{background:none;border:0;color:var(--dsw-alias-brand-primary);font:inherit;cursor:pointer;padding:0}
.tc-icon-button{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;background:none;border:0;border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);cursor:pointer}
.tc-icon-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tc-icon-button:disabled{opacity:.45;cursor:default}
.tc-warn{color:var(--dsw-alias-state-error-primary)}

/* 快速录入 */
.tc-quick{position:relative;flex:0 0 auto;padding:8px 0 0}
.tc-quick-field{display:flex;align-items:center;gap:8px;height:36px;padding:0 6px 0 12px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm)}
.tc-quick-field:focus-within{border-color:var(--dsw-focus-ring-color)}
.tc-quick-input{flex:1 1 auto;min-width:0;height:34px;background:none;border:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14)}
.tc-quick-input::placeholder{color:var(--dsw-alias-label-secondary)}
.tc-quick-input:disabled{opacity:.55;cursor:default}
.tc-quick-counter{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.tc-quick-help{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex:0 0 auto;background:none;border:0;border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-tertiary);cursor:pointer}
.tc-quick-syntax{position:absolute;left:0;top:calc(100% + 6px);z-index:24;width:320px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-shadow-lv2)}
.tc-syntax-group{display:flex;flex-direction:column;gap:2px;margin-bottom:6px}
.tc-syntax-name{color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-strong-12)}
.tc-syntax-values{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.tc-parse{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;margin-top:8px;padding:12px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.tc-parse-fields{display:flex;flex-direction:column;gap:10px;min-width:0}
.tc-parse-matched{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.tc-parse-chip{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}
.tc-parse-row{display:grid;grid-template-columns:120px minmax(0,1fr);gap:8px;align-items:start}
.tc-parse-label{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);line-height:28px}
.tc-parse-control{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.tc-parse-error{color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxs-12)}
.tc-parse-note{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.tc-parse-actions{display:flex;flex-direction:column;justify-content:flex-end;gap:8px;flex:0 0 auto}

/* 今日页 */
.tc-today{flex:1 1 auto;min-height:0;overflow:auto;padding-bottom:12px}
.tc-section{padding-top:0}
.tc-section + .tc-section{margin-top:16px;border-top:.5px solid var(--dsw-alias-border-l2)}
.tc-section-head{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:6px;width:100%;height:32px;padding:0 4px;background:var(--dsw-alias-bg-base);border:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-strong-13);text-align:left;cursor:pointer}
.tc-section-count{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.tc-section-arrow{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-tertiary)}
.tc-section-empty{padding:2px 4px 4px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}

/* 提醒 */
.tc-reminder{margin:8px 0;padding:8px 10px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,var(--dsw-alias-bg-layer-1));border:.5px solid var(--dsw-alias-border-l2);border-left:3px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 42%,var(--dsw-alias-label-primary));border-radius:var(--dsw-radius-sm)}
.tc-reminder-head{color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-strong-13)}
.tc-reminder-list{display:flex;flex-direction:column;max-height:240px;overflow:auto;margin-top:4px}
.tc-reminder-row{display:flex;align-items:center;gap:8px;min-height:32px}
.tc-reminder-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13)}
.tc-reminder-when{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.tc-reminder-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto}
.tc-badge-dot{position:absolute;top:-7px;right:-5px;width:8px;height:8px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 42%,var(--dsw-alias-label-primary))}
.tc-float{position:fixed;right:16px;bottom:16px;z-index:40;display:flex;flex-direction:column;gap:6px;width:320px;max-height:160px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-shadow-lv3);pointer-events:auto}
.tc-float-head{color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-strong-13)}
.tc-float-body{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tc-float-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px}

/* 象限令牌、标签与筛选 */
[data-tc-quadrant="urgent-important"]{--tc-quadrant:var(--dsw-alias-state-error-primary)}
[data-tc-quadrant="urgent-not-important"]{--tc-quadrant:var(--dsw-alias-state-warn-primary)}
[data-tc-quadrant="not-urgent-important"]{--tc-quadrant:var(--dsw-alias-state-business-primary)}
[data-tc-quadrant="not-urgent-not-important"]{--tc-quadrant:var(--dsw-alias-state-idle-primary)}
.tc-qchip{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:var(--dsw-radius-xs);background:color-mix(in srgb,var(--tc-quadrant) 12%,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}
.tc-qchip-dot{width:6px;height:6px;border-radius:3px;flex:0 0 auto;background:var(--tc-quadrant)}
.tc-tag{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 6px;border-radius:var(--dsw-radius-xs);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.tc-tag-x{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;background:none;border:0;border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);cursor:pointer}
.tc-tag-list{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}
.tc-filterbar{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:8px 0;flex-wrap:wrap}
.tc-filterbar .tc-input{flex:0 1 200px}
.tc-filter-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);cursor:pointer}
.tc-filter-btn[aria-expanded="true"]{border-color:var(--dsw-alias-brand-primary)}
.tc-filter-wrap{position:relative}
.tc-pop{position:absolute;left:0;top:calc(100% + 4px);z-index:24;display:flex;flex-direction:column;gap:4px;width:260px;max-height:320px;overflow:auto;padding:8px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-shadow-lv2)}
.tc-pop-row{display:flex;align-items:center;gap:8px;height:28px;padding:0 6px;border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);background:none;border:0;text-align:left;width:100%;cursor:pointer}
.tc-pop-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tc-pop-count{margin-left:auto;color:var(--dsw-alias-label-secondary)}
.tc-pop-foot{display:flex;align-items:center;gap:8px;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.tc-pop-empty{padding:12px 6px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.tc-preset-panel{position:absolute;right:0;top:calc(100% + 4px);z-index:24;display:flex;flex-direction:column;width:280px;padding:4px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-shadow-lv2)}
.tc-preset-row{display:flex;align-items:center;gap:8px;height:32px;padding:0 6px;border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}
.tc-preset-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tc-preset-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer;padding:0}
.tc-filter-note{padding:0 0 4px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}

/* 统计 */
.tc-stats{flex:1 1 auto;min-height:0;overflow:auto;padding-bottom:16px}
.tc-seg{display:inline-flex;align-items:center;gap:2px;height:28px;padding:2px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-active)}
.tc-seg-btn{height:24px;padding:0 10px;border:.5px solid transparent;border-radius:var(--dsw-radius-xs);background:none;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer}
.tc-seg-btn[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.tc-stats-range{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0}
.tc-stats-range-note{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.tc-stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.tc-stat-card{display:flex;flex-direction:column;gap:2px;padding:12px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.tc-stat-value{color:var(--dsw-alias-label-primary);font:var(--dsw-font-xl-24);font-variant-numeric:tabular-nums}
.tc-stat-label{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13)}
.tc-panel{margin-top:12px;padding:12px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.tc-panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-strong-13)}
.tc-panel-note{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-11)}
.tc-dist-row{display:grid;grid-template-columns:96px minmax(0,1fr) 88px;gap:10px;align-items:center;height:28px}
.tc-dist-label{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}
.tc-dist-track{height:10px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-interactive-bg-active)}
.tc-dist-fill{height:10px;border-radius:var(--dsw-radius-xs);background:color-mix(in srgb,var(--tc-quadrant) 42%,var(--dsw-alias-label-primary))}
.tc-dist-value{text-align:right;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums}
.tc-weeks{display:flex;align-items:flex-end;gap:8px;height:140px;padding-top:8px}
.tc-week-col{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;flex:1 1 0;min-width:0;height:100%}
.tc-week-bar{width:60%;min-height:2px;border-radius:3px 3px 0 0;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,var(--dsw-alias-label-primary))}
.tc-week-count{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-11)}
.tc-week-label{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-11)}
.tc-stats-note{margin-top:12px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}

/* 四象限 */
.tc-matrix{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;column-gap:8px;row-gap:4px}
.tc-matrix > .tc-grid{grid-column:2;grid-row:1;padding:0;position:relative}
.tc-axis{display:flex;align-items:center;justify-content:center;gap:4px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);letter-spacing:.16em;user-select:none}
.tc-axis-y{grid-column:1;grid-row:1;writing-mode:vertical-rl;transform:rotate(180deg)}
.tc-axis-x{grid-column:2;grid-row:2;padding-top:6px}
.tc-axis-arrow{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.tc-matrix > .tc-grid::before,.tc-matrix > .tc-grid::after{content:'';position:absolute;pointer-events:none;background:color-mix(in srgb,var(--dsw-alias-border-l2) 70%,transparent)}
.tc-matrix > .tc-grid::before{left:0;right:0;top:50%;height:1px}
.tc-matrix > .tc-grid::after{top:0;bottom:0;left:50%;width:1px}
.tc-grid{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:clamp(8px,0.9vw,16px);padding:0 0 16px}
.tc-grid-first-auto{grid-template-rows:auto 1fr}
.tc-grid-second-auto{grid-template-rows:1fr auto}
.tc-grid-both-auto{grid-template-rows:auto auto}
.tc-cell{display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-left:4px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md)}
.tc-cell-collapsed{align-self:start}
.tc-cell-collapsed .tc-cell-head{border-bottom:0}
.tc-cell-drop{border-style:dashed;animation:tc-breathe 1.2s ease-in-out infinite}
.tc-cell-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background-color:inherit;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.tc-cell-name{font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-primary)}
.tc-cell-level{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary);flex:0 0 auto}
.tc-cell-emoji{font:var(--dsw-font-xs-13);flex:0 0 auto}
.tc-cell-count{color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}
/* 四象限分级：逐格按固定比例设定方格底色与左缘，头部继承方格底色 */
.tc-cell[data-tc-quadrant="urgent-important"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 22%,var(--dsw-alias-bg-layer-1));border-left-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 68%,var(--dsw-alias-label-primary))}
.tc-cell[data-tc-quadrant="urgent-not-important"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,var(--dsw-alias-bg-layer-1));border-left-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 60%,var(--dsw-alias-label-primary))}
.tc-cell[data-tc-quadrant="not-urgent-important"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,var(--dsw-alias-bg-layer-1));border-left-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 52%,var(--dsw-alias-label-primary))}
.tc-cell[data-tc-quadrant="not-urgent-not-important"]{background:color-mix(in srgb,var(--dsw-alias-state-idle-primary) 8%,var(--dsw-alias-bg-layer-1));border-left-color:color-mix(in srgb,var(--dsw-alias-state-idle-primary) 36%,var(--dsw-alias-label-primary))}
.tc-cell-body{flex:1 1 auto;min-height:0;overflow:auto;padding:6px;display:flex;flex-direction:column;gap:6px;scrollbar-gutter:stable}
.tc-cell-body[data-tc-scrolled="1"]{box-shadow:inset 0 1px 0 0 color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent)}
.tc-card-flow{display:flex;flex-direction:column;flex:0 0 auto;min-height:0;padding:2px 0 0;gap:6px}
.tc-empty{display:block;width:100%;text-align:left;background:none;border:0;padding:16px;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.tc-empty:disabled{cursor:default}

/* 卡片 */
.tc-card{position:relative;display:flex;align-items:center;box-sizing:border-box;flex:0 0 auto;height:44px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l1);border-left:3px solid var(--tc-card-accent,var(--dsw-alias-border-l1));background:var(--dsw-alias-bg-layer-2);animation:tc-rise var(--tc-dur-base) var(--tc-ease);transition:box-shadow var(--tc-dur-fast) var(--tc-ease),background-color var(--tc-dur-fast) var(--tc-ease),border-color var(--tc-dur-fast) var(--tc-ease)}
.tc-card-has-error{height:auto;flex-direction:column;align-items:stretch;padding:6px 10px;row-gap:4px}
.tc-card:hover{box-shadow:var(--dsw-shadow-lv2);border-top-color:var(--dsw-alias-border-l3);border-right-color:var(--dsw-alias-border-l3);border-bottom-color:var(--dsw-alias-border-l3)}
.tc-card-overdue{border-top:1px solid var(--dsw-alias-state-error-primary);border-right:1px solid var(--dsw-alias-state-error-primary);border-bottom:1px solid var(--dsw-alias-state-error-primary)}
.tc-card-selected{box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}
.tc-card-highlight{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}
/* 卡片左缘与标题前的象限圆点取所在象限 56% 混 label-primary，保证对卡片面的对比度 */
.tc-card[data-tc-card-quadrant="urgent-important"]{--tc-card-accent:color-mix(in srgb,var(--dsw-alias-state-error-primary) 56%,var(--dsw-alias-label-primary))}
.tc-card[data-tc-card-quadrant="urgent-not-important"]{--tc-card-accent:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 56%,var(--dsw-alias-label-primary))}
.tc-card[data-tc-card-quadrant="not-urgent-important"]{--tc-card-accent:color-mix(in srgb,var(--dsw-alias-state-business-primary) 56%,var(--dsw-alias-label-primary))}
.tc-card[data-tc-card-quadrant="not-urgent-not-important"]{--tc-card-accent:color-mix(in srgb,var(--dsw-alias-state-idle-primary) 56%,var(--dsw-alias-label-primary))}
.tc-card-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--tc-card-accent,var(--dsw-alias-label-tertiary));flex:0 0 auto}
.tc-card-main{display:grid;grid-template-columns:24px minmax(0,1fr) 104px;column-gap:10px;align-items:center;flex:1 1 auto;min-width:0}
.tc-card-head{display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden}
.tc-card-title-button{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:96px;text-align:left;background:none;border:0;padding:0;color:inherit;font:var(--dsw-font-xs-strong-13);cursor:pointer;overflow:hidden}
.tc-card-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tc-card-title-done{text-decoration:line-through;color:var(--dsw-alias-label-secondary)}
.tc-card-marks{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;flex:0 1 auto;mask-image:linear-gradient(to right,#000 calc(100% - 10px),transparent)}
.tc-card-mark{display:inline-flex;align-items:center;height:16px;padding:0 5px;border-radius:var(--dsw-radius-xs);border:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-11);background:none;white-space:nowrap}
.tc-card-mark-button{cursor:pointer}
.tc-card-side{position:relative;display:flex;align-items:center;justify-content:flex-end;min-width:0}
.tc-card-time{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity var(--tc-dur-fast) var(--tc-ease)}
.tc-card-time-late{color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 88%,var(--dsw-alias-label-primary))}
.tc-card-actions{position:absolute;top:50%;right:0;transform:translateY(-50%);display:flex;gap:2px;align-items:center;padding-left:12px;background:linear-gradient(to right,transparent,var(--dsw-alias-bg-layer-2) 12px);opacity:0;pointer-events:none;transition:opacity var(--tc-dur-fast) var(--tc-ease)}
.tc-card:hover .tc-card-actions,.tc-card:focus-within .tc-card-actions{opacity:1;pointer-events:auto}
.tc-card:hover .tc-card-time,.tc-card:focus-within .tc-card-time{opacity:0}
.tc-card-error{padding:0;color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 88%,var(--dsw-alias-label-primary));font:var(--dsw-font-xxs-12);min-width:0;overflow-wrap:anywhere}
.tc-check-slot{display:flex;align-items:center;justify-content:center;width:24px;height:24px;flex:0 0 auto}
.tc-check{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:16px;height:16px;padding:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-bg-base);font:var(--dsw-font-xxxs-11);accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0}
.tc-check[aria-pressed="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.tc-check:disabled{cursor:default;opacity:.55}
.tc-mark{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs);padding:0 6px;background:none}
.tc-mark-session{display:inline-flex;align-items:center;gap:4px;height:16px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary);background:none;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs);padding:0 5px;cursor:pointer;white-space:nowrap}

/* 抽屉里的字段区：外层由抽屉负责边框与滚动 */
.tc-editor{display:flex;flex-direction:column;gap:10px;min-width:0}
.tc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.tc-child-row{display:flex;gap:6px;align-items:center}
.tc-child-row .tc-input{flex:1 1 auto;min-width:0}
.tc-field{display:flex;flex-direction:column;gap:4px;flex:0 0 auto;min-width:0}
/* 只有描述框吸收抽屉里的剩余高度，其余字段按内容高度排列 */
.tc-drawer-body > .tc-editor{flex:1 1 auto;min-height:0}
.tc-field-grow{flex:1 1 auto;min-height:92px}
.tc-field-grow .tc-textarea{flex:1 1 auto;min-height:70px}
.tc-field-name{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.tc-hint{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}

/* 抽屉里的象限选择：四个带颜色的选项，两列排布 */
.tc-quadrant-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.tc-quadrant-option{display:flex;align-items:center;gap:6px;box-sizing:border-box;min-height:34px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);text-align:left;cursor:pointer}
.tc-quadrant-option:hover:not([disabled]){background:color-mix(in srgb,var(--tc-quadrant) 12%,var(--dsw-alias-bg-layer-1))}
.tc-quadrant-option[aria-checked="true"]{border-color:color-mix(in srgb,var(--tc-quadrant) 56%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--tc-quadrant) 20%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary)}
.tc-quadrant-dot{width:8px;height:8px;border-radius:50%;background:var(--tc-quadrant);flex:0 0 auto}
.tc-quadrant-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-tc-quadrant-option="urgent-important"]{--tc-quadrant:var(--dsw-alias-state-error-primary)}
[data-tc-quadrant-option="urgent-not-important"]{--tc-quadrant:var(--dsw-alias-state-warn-primary)}
[data-tc-quadrant-option="not-urgent-important"]{--tc-quadrant:var(--dsw-alias-state-business-primary)}
[data-tc-quadrant-option="not-urgent-not-important"]{--tc-quadrant:var(--dsw-alias-state-idle-primary)}

/* 对话框 */
.tc-modal-mask{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:center;justify-content:center;z-index:50}
.tc-modal{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:16px;width:480px;max-width:calc(100vw - 32px);max-height:min(80vh,720px);overflow:auto;display:flex;flex-direction:column;gap:10px;box-shadow:var(--dsw-shadow-lv3)}
.tc-modal-wide{width:560px}
.tc-modal-title{font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-primary)}
.tc-modal-text{white-space:pre-wrap;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13)}
.tc-modal-note{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);white-space:pre-wrap}
.tc-modal-error{padding:10px;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxs-12);white-space:pre-wrap}
.tc-modal-list{display:flex;flex-direction:column;max-height:280px;overflow:auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.tc-modal-list-row{display:flex;align-items:center;gap:8px;height:32px;padding:0 8px;background:none;border:0;border-bottom:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);text-align:left;cursor:pointer}
.tc-modal-list-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tc-modal-list-when{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}

/* 右侧抽屉：添加与编辑共用，遮罩靠右，面板占满视口高度 */
.tc-drawer-mask{align-items:stretch;justify-content:flex-end}
.tc-drawer{box-sizing:border-box;width:420px;max-width:100vw;height:100%;max-height:none;padding:0;gap:0;overflow:hidden;border-radius:var(--dsw-radius-md) 0 0 var(--dsw-radius-md);border-right:0;animation:tc-drawer-in 180ms var(--tc-ease)}
.tc-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.tc-drawer-title{margin:0}
.tc-drawer-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.tc-drawer-foot{justify-content:flex-end;flex:0 0 auto;margin-top:0;padding:12px 16px;border-top:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
@keyframes tc-drawer-in{from{transform:translateX(24px);opacity:0}to{transform:translateX(0);opacity:1}}
@media (max-width:1024px){.tc-drawer{width:92vw}}

/* 已完成清单 */
.tc-list-view{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;padding:0 0 12px}
.tc-list-head{display:flex;align-items:center;gap:8px;min-height:32px;padding:6px 8px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);border-bottom:.5px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.tc-list-row{display:grid;grid-template-columns:minmax(0,1fr) 120px 150px auto;gap:10px;align-items:center;min-height:36px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.tc-list-row:hover{background:var(--dsw-alias-bg-layer-1)}
.tc-list-title{display:flex;align-items:center;gap:8px;min-width:0}
.tc-list-actions{display:flex;align-items:center;gap:4px;justify-content:flex-end}
.tc-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* 批量条 */
.tc-batchbar{position:sticky;bottom:0;display:flex;gap:8px;align-items:center;padding:8px 0;border-top:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:0 0 auto;min-height:44px}

/* 侧栏图标 */
.tc-icon-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center}
.tc-badge{position:absolute;top:-5px;right:-7px;min-width:15px;height:15px;line-height:15px;padding:0 4px;border-radius:var(--dsw-radius-sm);font-size:10px;text-align:center;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.tc-badge-alert{background:var(--dsw-alias-state-error-primary)}

/* 输入框上方待确认提示条 */
.tc-dock{display:flex;align-items:center;gap:8px;margin:0 auto 6px;padding:6px 12px;max-width:760px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);overflow:auto}
.tc-dock-text{font:var(--dsw-font-xs-strong-13);flex:0 0 auto}
.tc-dock-note{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tc-dock-error{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;min-width:0}
.tc-card-meta-item{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.tc-child{display:flex;gap:6px;align-items:center;padding:2px 0}
.tc-child-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tc-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.tc-modal-list-row-on{background:var(--dsw-alias-bg-module-platform)}
.tc-sync-body{display:flex;flex-direction:column;gap:12px;min-height:0;overflow:auto}
.tc-sync-section{display:flex;flex-direction:column;gap:8px;padding:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.tc-sync-strong{font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-primary)}
.tc-sync-row{display:flex;align-items:center;gap:8px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary);min-height:24px}
.tc-sync-label{flex:0 0 96px;color:var(--dsw-alias-label-secondary)}
.tc-sync-value{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tc-sync-badge{flex:0 0 auto;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.tc-sync-badge-ok{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.tc-sync-badge-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.tc-sync-note{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);white-space:pre-wrap}
.tc-sync-stack{display:flex;flex-direction:column;gap:8px;min-width:0}
.tc-sync-url{word-break:break-all;user-select:all;color:var(--dsw-alias-state-business-primary);font:var(--dsw-font-xxs-12)}
.tc-sync-qr{font:var(--dsw-font-xxs-12);line-height:.95;white-space:pre;overflow:auto;max-height:220px;color:var(--dsw-alias-label-primary);margin:0}
.tc-sync-actions{display:flex;flex-wrap:wrap;gap:8px}
.tc-sync-select{max-width:100%;flex:1 1 auto;min-width:0}
.tc-sync-log{max-height:96px;overflow:auto;margin:0;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);white-space:pre-wrap}

.tc-kv-row{display:flex;align-items:baseline;gap:8px;padding:2px 0}
.tc-kv-name{color:var(--dsw-alias-label-secondary);flex:0 0 96px}
.tc-kv-value{color:var(--dsw-alias-label-primary);min-width:0;overflow-wrap:anywhere}

/* 断点 */
@media (max-width:1180px){.tc-grid{gap:8px}.tc-cell-name{font-size:12px}}
/* 面板内容宽度不足时改为纵向布局，整页滚动 */
@container (max-width:640px){.tc-shell{overflow-y:auto}.tc-grid{flex:0 0 auto;height:auto;grid-template-columns:minmax(0,1fr);grid-template-rows:none;grid-auto-rows:auto}.tc-grid-first-auto,.tc-grid-second-auto,.tc-grid-both-auto{grid-template-rows:none}.tc-cell{min-height:40vh}.tc-cell-collapsed{min-height:0}}

/* 动效 */
@keyframes tc-rise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@keyframes tc-fade-quadrants{from{opacity:0}to{opacity:1}}
@keyframes tc-fade-today{from{opacity:0}to{opacity:1}}
@keyframes tc-fade-completed{from{opacity:0}to{opacity:1}}
@keyframes tc-fade-stats{from{opacity:0}to{opacity:1}}
@keyframes tc-breathe{0%,100%{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l1))}50%{border-color:var(--dsw-alias-brand-primary)}}
.tc-button,.tc-icon-button,.tc-filter-btn,.tc-tab,.tc-check{transition:transform var(--tc-dur-fast) var(--tc-ease),background-color var(--tc-dur-fast) var(--tc-ease),border-color var(--tc-dur-fast) var(--tc-ease),color var(--tc-dur-fast) var(--tc-ease)}
.tc-button:active:not(:disabled),.tc-icon-button:active:not(:disabled),.tc-filter-btn:active:not(:disabled),.tc-tab:active,.tc-check:active:not(:disabled){transform:scale(.94)}
.tc-section-arrow{transition:transform var(--tc-dur-base) var(--tc-ease)}
.tc-section-head[aria-expanded="false"] .tc-section-arrow{transform:rotate(180deg)}
@media (prefers-reduced-motion:reduce){.tc-page,.tc-page *{animation-duration:0s !important;animation-iteration-count:1 !important;transition-duration:0s !important}}
`

    // ---------- 样式注入 ----------

    const STYLE_TAG_ID = 'dsh-4quadrant-todo'

    // 整页只注入一份样式表，卸载面板时不移除，避免其它挂载点丢失样式
    function StyleSheet() {
      useEffect(() => {
        if (document.querySelector(`style[data-plugin="${STYLE_TAG_ID}"]`) !== null) return
        const tag = document.createElement('style')
        tag.dataset.plugin = STYLE_TAG_ID
        tag.textContent = STYLE_TEXT
        document.head.appendChild(tag)
      }, [])
      return null
    }

    // ---------- 图标 ----------

    const ICON_PATHS = {
      edit: 'M4 20h4L18 10l-4-4L4 16v4z M14 6l4 4',
      trash: 'M4 7h16 M9 7V5h6v2 M6.5 7l1 13h9l1-13',
      chat: 'M4 5h16v11H9l-5 4z',
      more: 'M6 12h.01 M12 12h.01 M18 12h.01',
      repeat: 'M4 10a6 6 0 0 1 6-6h7 M17 1.8l2.2 2.2L17 6.2 M20 14a6 6 0 0 1-6 6H7 M7 22.2L4.8 20 7 17.8',
      down: 'M6 9l6 6 6-6',
      up: 'M6 15l6-6 6 6',
      close: 'M6 6l12 12 M18 6L6 18',
      check: 'M4.5 12.5l5 5 10-11'
    }

    function iconSvg(name, size) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' }
      }, h('path', { d: ICON_PATHS[name] }))
    }

    function iconButton(options) {
      return h('button', {
        className: 'tc-icon-button',
        onClick: options.onClick,
        disabled: options.disabled === true,
        title: options.title,
        'aria-label': options.label
      }, iconSvg(options.icon, options.size ?? 16))
    }

    // ---------- 侧栏入口 ----------

    function PanelIcon(props) {
      const snapshot = useStore()
      const size = typeof props.size === 'number' ? props.size : 20

      useEffect(() => {
        if (!store.loaded && !store.loading) loadSnapshot()
      }, [])

      const now = Date.now()
      const openItems = snapshot.todos.filter((item) => item.parentId === null && item.status === 'open')
      const hasOverdue = openItems.some((item) => isOverdue(item, now))
      const reminderCount = snapshot.reminderCount

      return h('span', { className: 'tc-icon-wrap', style: { width: `${size}px`, height: `${size}px` } },
        h(StyleSheet),
        h('svg', {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' }
        },
          h('path', { d: 'M3.4 6.1 L4.7 7.5 L7.4 4.5 M3.4 12.1 L4.7 13.5 L7.4 10.5 M3.4 18.1 L4.7 19.5 L7.4 16.5' }),
          h('path', { d: 'M10 6 H20.6 M10 12 H20.6 M10 18 H20.6' })
        ),
        reminderCount > 0
          ? h('span', {
            className: 'tc-badge-dot',
            title: `${reminderCount} 条待办已到提醒时间`,
            'aria-label': `${reminderCount} 条待办已到提醒时间`,
            'data-tc-reminder-dot': '1'
          })
          : null,
        openItems.length > 0
          ? h('span', { className: hasOverdue ? 'tc-badge tc-badge-alert' : 'tc-badge' }, openItems.length > 99 ? '99+' : String(openItems.length))
          : null
      )
    }

    // ---------- 跨面板提醒浮层 ----------

    function ReminderOverlay() {
      const snapshot = useStore()
      const overlay = snapshot.reminderOverlay

      useEffect(() => {
        if (overlay === null) return undefined
        const timer = setTimeout(() => dismissReminderOverlay(), 10000)
        return () => clearTimeout(timer)
      }, [overlay])

      if (overlay === null) return null

      function openToday() {
        dismissReminderOverlay()
        requestTab('today')
        const ctx = runtime.ctx
        if (ctx !== null) ctx.layout.selectPanel(PANEL_ID)
      }

      return h('div', { className: 'tc-float', role: 'status', 'aria-live': 'polite' },
        h(StyleSheet),
        h('div', { className: 'tc-float-head' }, `${overlay.count} 条待办已到提醒时间`),
        h('div', { className: 'tc-float-body' }, `${overlay.title} · 截止 ${formatClock(overlay.dueAt)}`),
        h('div', { className: 'tc-float-actions' },
          h('button', { className: 'tc-button tc-button-small', onClick: openToday }, '查看'),
          h('button', { className: 'tc-button tc-button-small', onClick: dismissReminderOverlay }, '知道了')
        )
      )
    }

    // ---------- 会话能力 ----------

    function firstMessageOf(item) {
      const description = item.description.trim()
      return description === '' ? item.title : `${item.title}\n\n${description}`
    }

    function sessionCapability() {
      const ctx = runtime.ctx
      if (ctx === null) return null
      if (ctx.sessions === undefined || ctx.sessions === null) return null
      if (typeof ctx.sessions.create !== 'function' || typeof ctx.sessions.using !== 'function') return null
      if (ctx.uiWorkspace === undefined || ctx.uiWorkspace === null) return null
      if (typeof ctx.uiWorkspace.openSession !== 'function') return null
      return ctx
    }

    function fileStamp(date) {
      return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
    }

    function downloadText(text, fileName, mime) {
      const blob = new Blob([text], { type: mime })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    }

    function todaySectionOf(item, now) {
      const due = dueTime(item)
      if (due === null) return 'unscheduled'
      if (minuteOf(due) < minuteOf(now)) return 'overdue'
      const start = startOfToday(now)
      if (due < addDays(start, 1)) return 'today'
      if (due < addDays(start, 8)) return 'next7'
      return 'later'
    }

    function compareByCreated(left, right) {
      return Date.parse(left.createdAt) - Date.parse(right.createdAt)
    }

    // ---------- 页面 ----------

    function TodoCenterPage(props) {
      const snapshot = useStore()
      const workspaces = props.useWorkspaces((state) => state.items)
      const readOnly = snapshot.readOnly === true
      const [tab, setTab] = useState('quadrants')
      const [scopeKey, setScopeKey] = useState('all')
      const [conditions, setConditions] = useState(emptyConditions)
      const [presetId, setPresetId] = useState(null)
      const [doneRange, setDoneRange] = useState('week')
      const [doneFrom, setDoneFrom] = useState('')
      const [doneTo, setDoneTo] = useState('')
      const [selectMode, setSelectMode] = useState(false)
      const [selectedIds, setSelectedIds] = useState([])
      const [editor, setEditor] = useState(null)
      const [confirmState, setConfirmState] = useState(null)
      const [dialog, setDialog] = useState(null)
      const [toolsOpen, setToolsOpen] = useState(false)
      const [toolsNote, setToolsNote] = useState(null)
      const [banner, setBanner] = useState(null)
      const [focusId, setFocusId] = useState(null)
      const [highlightId, setHighlightId] = useState(null)
      const [sessionErrors, setSessionErrors] = useState({})
      const [now, setNow] = useState(() => Date.now())
      const [tagsOpen, setTagsOpen] = useState(false)
      const [feishuOpen, setFeishuOpen] = useState(false)
      const [presetOpen, setPresetOpen] = useState(false)
      const [openMenuId, setOpenMenuId] = useState(null)
      const fileRef = useRef(null)

      useEffect(() => {
        if (!store.loaded && !store.loading) loadSnapshot()
      }, [])

      // 面板重新显示或窗口回到前台时读一次数据，其他窗口的改动随即反映到本窗口
      useEffect(() => {
        function refresh() {
          if (document.visibilityState === 'hidden') return
          loadSnapshot()
        }
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', refresh)
        return () => {
          window.removeEventListener('focus', refresh)
          document.removeEventListener('visibilitychange', refresh)
        }
      }, [])

      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60000)
        return () => clearInterval(timer)
      }, [])

      // 数据一变就刷新页面时钟，时间派生（已完成范围、逾期判定、今日分区）随即按当前时刻重算
      useEffect(() => {
        setNow(Date.now())
      }, [snapshot.todos])

      useEffect(() => {
        if (pendingFocusId === null) return
        setFocusId(pendingFocusId)
        pendingFocusId = null
      }, [snapshot])

      useEffect(() => {
        if (pendingTab === null) return
        setTab(pendingTab)
        pendingTab = null
      }, [snapshot])

      useEffect(() => {
        if (highlightId === null) return undefined
        const timer = setTimeout(() => setHighlightId(null), 2000)
        return () => clearTimeout(timer)
      }, [highlightId])

      useEffect(() => {
        if (focusId === null) return
        const node = document.querySelector(`[data-tc-todo-id="${focusId}"]`)
        if (node !== null) node.scrollIntoView({ block: 'center' })
      }, [focusId, snapshot])

      useEffect(() => {
        if (toolsNote === null) return undefined
        const timer = setTimeout(() => setToolsNote(null), 5000)
        return () => clearTimeout(timer)
      }, [toolsNote])

      useEffect(() => {
        function onKeyDown(event) {
          if (event.key !== 'Escape') return
          if (dialog !== null) {
            if (dialog.busy === true) return
            setDialog(null)
            return
          }
          if (openMenuId !== null) {
            setOpenMenuId(null)
            return
          }
          if (tagsOpen || presetOpen) {
            setTagsOpen(false)
            setPresetOpen(false)
            return
          }
          if (confirmState !== null) {
            setConfirmState(null)
            return
          }
          if (editor !== null) {
            setEditor(null)
            return
          }
          if (selectMode) {
            setSelectMode(false)
            setSelectedIds([])
            return
          }
          closePanel()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [dialog, confirmState, editor, selectMode, tagsOpen, presetOpen, openMenuId])

      const todos = snapshot.todos
      const readOnlyReason = '数据格式为 1.0，请先升级'

      const childrenByParent = useMemo(() => {
        const map = new Map()
        for (const item of todos) {
          if (item.parentId === null) continue
          const list = map.get(item.parentId)
          if (list === undefined) map.set(item.parentId, [item])
          else list.push(item)
        }
        return map
      }, [todos])

      const tagCandidates = useMemo(() => tagCandidatesOf(todos, 20), [todos])
      const tagCounts = useMemo(() => Object.fromEntries(tagUsage(todos)), [todos])

      // 取指定父待办下仍未完成的子待办
      const openChildrenOf = useCallback((parentId) => (childrenByParent.get(parentId) ?? [])
        .filter((child) => child.status === 'open'), [childrenByParent])

      const workspaceTitles = useMemo(() => {
        const map = new Map()
        for (const workspace of workspaces) map.set(workspace.workspaceId, workspace.title)
        return map
      }, [workspaces])

      const matchesOpen = useCallback((item) => matchesConditions(item, conditions, now), [conditions, now])

      const doneConditions = useMemo(() => ({
        ...conditions,
        quadrants: [],
        dueState: 'all',
        dueRange: { kind: 'any', from: null, to: null }
      }), [conditions])

      const quadrantLists = useMemo(() => {
        const map = new Map(QUADRANT_IDS.map((id) => [id, []]))
        for (const item of todos) {
          if (item.parentId !== null || item.status !== 'open') continue
          if (!scopeMatches(item, scopeKey)) continue
          if (!matchesOpen(item)) continue
          map.get(item.quadrant).push(item)
        }
        for (const list of map.values()) list.sort(compareTodos)
        return map
      }, [todos, scopeKey, matchesOpen])

      const todayGroups = useMemo(() => {
        const groups = new Map(TODAY_SECTIONS.map((section) => [section.id, []]))
        for (const item of todos) {
          if (item.parentId !== null || item.status !== 'open') continue
          if (!scopeMatches(item, scopeKey)) continue
          if (!matchesOpen(item)) continue
          groups.get(todaySectionOf(item, now)).push(item)
        }
        for (const [id, list] of groups) list.sort(id === 'unscheduled' ? compareByCreated : compareTodos)
        return groups
      }, [todos, scopeKey, matchesOpen, now])

      const completedItems = useMemo(() => {
        return todos
          .filter((item) => item.parentId === null && item.status === 'done')
          .filter((item) => scopeMatches(item, scopeKey))
          .filter((item) => matchesConditions(item, doneConditions, now))
          .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))
      }, [todos, scopeKey, doneConditions, now])

      const selection = useMemo(() => new Set(selectedIds), [selectedIds])
      const collapsedMap = store.collapsed[scopeKey] ?? {}
      const activePreset = snapshot.filters.find((preset) => preset.id === presetId) ?? null
      const presetModified = activePreset !== null && !conditionsEqual(activePreset.conditions, conditions)
      const missingTags = missingTagsOf(conditions, todos)
      const canStartSession = sessionCapability() !== null

      function closePanel() {
        const ctx = runtime.ctx
        if (ctx !== null) ctx.layout.selectPanel(null)
      }

      function toggleSelected(id) {
        setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])
      }

      function selectAllVisible() {
        const ids = []
        if (tab === 'quadrants') {
          for (const list of quadrantLists.values()) for (const item of list) ids.push(item.id)
        }
        if (tab === 'today') {
          for (const list of todayGroups.values()) for (const item of list) ids.push(item.id)
        }
        setSelectedIds(ids)
      }

      function toggleCollapseQuadrant(quadrantId) {
        if (readOnly) return
        const current = store.collapsed[scopeKey] ?? {}
        const nextValue = current[quadrantId] !== true
        runWrite(() => call('/setCollapsed', { scopeKey, quadrant: quadrantId, collapsed: nextValue }))
      }

      function highlightNewInstance(value, completedIds) {
        if (value === null) return
        const created = (value.upserted ?? []).find((entry) => completedIds.includes(entry.generatedFromId) && entry.status === 'open')
        if (created === undefined) return
        setHighlightId(created.id)
      }

      async function completeOne(item) {
        if (readOnly) return
        const openChildren = openChildrenOf(item.id)
        if (openChildren.length > 0) {
          setConfirmState({
            text: `「${item.title}」还有 ${openChildren.length} 个未完成的子待办，同时完成它们吗？`,
            confirmLabel: '一并完成',
            run: async () => {
              const value = await runWrite(() => call('/complete', { ids: [item.id], includeChildren: true }))
              highlightNewInstance(value, [item.id])
            }
          })
          return
        }
        const value = await runWrite(() => call('/complete', { ids: [item.id], includeChildren: false }))
        highlightNewInstance(value, [item.id])
      }

      async function completeSelected() {
        if (readOnly || selectedIds.length === 0) return
        const needMerge = selectedIds.some((id) => openChildrenOf(id).length > 0)
        if (needMerge) {
          setConfirmState({
            text: '选中的待办里存在未完成的子待办，同时完成全部子待办吗？',
            confirmLabel: '一并完成',
            run: async () => {
              await runWrite(() => call('/complete', { ids: selectedIds, includeChildren: true }))
              setSelectedIds([])
            }
          })
          return
        }
        await runWrite(() => call('/complete', { ids: selectedIds, includeChildren: false }))
        setSelectedIds([])
      }

      function removeItem(item) {
        if (readOnly) return
        const childCount = pickChildIds(todos, item.id).length
        const suffix = childCount > 0 ? `，并一并删除 ${childCount} 个子待办` : ''
        setConfirmState({
          text: `永久删除「${item.title}」${suffix}？此操作不可恢复。`,
          confirmLabel: '永久删除',
          run: () => runWrite(() => call('/remove', { ids: [item.id] }))
        })
      }

      function moveToQuadrant(quadrantId) {
        if (readOnly || selectedIds.length === 0) return
        runWrite(() => call('/setQuadrant', { ids: selectedIds, quadrant: quadrantId }))
        setSelectedIds([])
      }

      function openCreate(quadrantId) {
        if (readOnly) return
        setEditor({ mode: 'create', quadrant: quadrantId, trigger: document.activeElement })
      }

      function openEdit(item) {
        if (readOnly) return
        setEditor({ mode: 'edit', item, trigger: document.activeElement })
      }

      function openSource(item) {
        if (item.source.kind !== 'conversation') return
        runtime.ctx.uiWorkspace.openSession(item.source.sessionId)
        closePanel()
      }

      function openStartedSession(item) {
        if (item.startedSessionId === null) return
        try {
          const opened = runtime.ctx.uiWorkspace.openSession(item.startedSessionId)
          if (opened !== undefined && typeof opened.then === 'function') {
            opened.catch(() => setSessionErrors((current) => ({ ...current, [item.id]: '会话不存在' })))
          }
        } catch (error) {
          setSessionErrors((current) => ({ ...current, [item.id]: '会话不存在' }))
        }
      }

      function beginSession(item) {
        if (readOnly) return
        if (item.startedSessionId !== null) {
          setConfirmState({
            title: '已有会话',
            text: '该待办已有一个会话，将新建一个会话并替换标记。',
            confirmLabel: '新建会话',
            run: () => startSession(item)
          })
          return
        }
        startSession(item)
      }

      async function startSession(item) {
        const ctx = sessionCapability()
        if (ctx === null) return
        setSessionErrors((current) => {
          const next = { ...current }
          delete next[item.id]
          return next
        })
        try {
          const created = item.workspaceId === null
            ? await ctx.sessions.create({})
            : await ctx.sessions.create({ workspaceId: item.workspaceId })
          ctx.uiWorkspace.openSession(created)
          const text = firstMessageOf(item)
          await ctx.sessions.using(created, { source: 'controllerOperation' }, async (reference) => {
            const binding = await reference.ready
            const handle = binding.session.beginSubmission({ mode: 'queue', text, attachments: [] })
            const result = await binding.session.prompt([{ type: 'text', text }], 'queue', undefined, handle.requestId)
            if (result.ok !== true) {
              handle.abandon()
              throw new Error(result.error === undefined ? '首条消息发送失败' : result.error.message)
            }
          })
          try {
            const value = await call('/update', {
              id: item.id,
              startedSessionId: created,
              startedAt: new Date().toISOString()
            })
            applyDelta(value)
            publish()
          } catch (error) {
            setSessionErrors((current) => ({ ...current, [item.id]: '会话已创建，关联保存失败' }))
          }
        } catch (error) {
          setSessionErrors((current) => ({ ...current, [item.id]: messageOf(error) }))
        }
      }

      function openDuplicate(item) {
        if (readOnly) return
        setDialog({ kind: 'duplicate', sourceId: item.id, targetId: null, search: '', error: null })
      }

      async function confirmDuplicate() {
        const state = dialog
        if (state === null || state.kind !== 'duplicate' || state.targetId === null) return
        try {
          const value = await call('/duplicateRecurrence', { sourceId: state.sourceId, targetId: state.targetId })
          applyDelta(value)
          publish()
          setDialog(null)
        } catch (error) {
          setDialog({ ...state, error: messageOf(error) })
        }
      }

      function applyPreset(preset) {
        setConditions(normalizeConditions(preset.conditions))
        setPresetId(preset.id)
      }

      function clearConditions() {
        setConditions(emptyConditions())
        setPresetId(null)
      }

      function openPresetSave(mode) {
        if (readOnly) return
        const name = mode === 'update' && activePreset !== null ? activePreset.name : ''
        setDialog({ kind: 'preset', mode, name, error: null })
      }

      async function savePreset() {
        const state = dialog
        if (state === null || state.kind !== 'preset') return
        const name = state.name.trim()
        if (name === '') {
          setDialog({ ...state, error: '名称不能为空' })
          return
        }
        if (name.length > 40) {
          setDialog({ ...state, error: '名称不能超过 40 字' })
          return
        }
        const preset = state.mode === 'update' && activePreset !== null
          ? { id: activePreset.id, name, conditions }
          : { name, conditions }
        try {
          const value = await call('/filterSave', { preset })
          applyDelta(value)
          publish()
          setDialog(null)
        } catch (error) {
          setDialog({ ...state, error: messageOf(error) })
        }
      }

      async function removePreset(preset) {
        if (readOnly) return
        setConfirmState({
          text: `删除预设「${preset.name}」？`,
          confirmLabel: '删除',
          run: async () => {
            try {
              const value = await call('/filterRemove', { id: preset.id })
              applyDelta(value)
              publish()
              if (presetId === preset.id) setPresetId(null)
            } catch (error) {
              setBanner({ kind: 'error', text: messageOf(error) })
            }
          }
        })
      }

      async function completeReminder(reminder) {
        if (readOnly) return
        const value = await runWrite(() => call('/complete', { ids: [reminder.id], includeChildren: false }))
        if (value !== null) await loadReminders()
      }

      async function snoozeReminder(reminder) {
        if (readOnly) return
        const value = await runWrite(() => call('/snooze', { id: reminder.id, minutes: 10 }))
        if (value !== null) await loadReminders()
      }

      async function exportAll() {
        setToolsOpen(false)
        try {
          const value = await call('/export')
          const text = JSON.stringify(value, null, 2)
          downloadText(text, `four-quadrant-todo-backup-${fileStamp(new Date())}.json`, 'application/json')
          const count = Array.isArray(value.todos) ? value.todos.length : 0
          setToolsNote(`已导出 ${count} 条；若没有开始下载，可改用「复制 JSON」`)
        } catch (error) {
          setBanner({ kind: 'error', text: messageOf(error) })
        }
      }

      async function copyJson() {
        setToolsOpen(false)
        try {
          const value = await call('/export')
          await navigator.clipboard.writeText(JSON.stringify(value, null, 2))
          setToolsNote('已复制')
        } catch (error) {
          setBanner({ kind: 'error', text: messageOf(error) })
        }
      }

      function beginImport() {
        setToolsOpen(false)
        const node = fileRef.current
        if (node === null) return
        node.value = ''
        node.click()
      }

      async function readImportFile(event) {
        const list = event.target.files
        const file = list !== null && list.length > 0 ? list[0] : null
        if (file === null) return
        if (file.size > 32 * 1024 * 1024) {
          setDialog({ kind: 'import', fileName: file.name, payload: null, error: '导入文件超过 32 MB' })
          return
        }
        let payload = null
        let error = null
        try {
          payload = JSON.parse(await file.text())
        } catch (parseError) {
          error = `导入文件不是合法的 JSON：${messageOf(parseError)}`
        }
        if (error === null) {
          if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) error = '导入文件必须是对象'
          else if (payload.version !== 1 && payload.version !== 2) error = `导入文件的 version 为 ${String(payload.version)}，允许 1 或 2`
          else if (!Array.isArray(payload.todos)) error = '导入文件的 todos 必须是数组'
          else if (payload.todos.length > 20000) error = '条目数超过 20000'
        }
        setDialog({ kind: 'import', fileName: file.name, payload: error === null ? payload : null, error })
      }

      async function confirmImport() {
        const state = dialog
        if (state === null || state.kind !== 'import' || state.payload === null) return
        setDialog({ ...state, busy: true, error: null })
        try {
          const value = await call('/import', { payload: state.payload, fileName: state.fileName })
          setDialog(null)
          setBanner({
            kind: 'import',
            text: `已导入 ${value.importedCount} 条，原数据已备份为 ${value.backupFile}`,
            backupFile: value.backupFile
          })
          await loadSnapshot()
          await loadReminders()
        } catch (error) {
          setDialog({ ...state, busy: false, error: messageOf(error) })
        }
      }

      async function undoImport() {
        const state = banner
        if (state === null || state.backupFile === undefined) return
        try {
          const value = await call('/import/undo', { backupFile: state.backupFile })
          setBanner({ kind: 'undo', text: `已撤销导入，恢复到 ${value.restoredCount} 条` })
          await loadSnapshot()
          await loadReminders()
        } catch (error) {
          setBanner({ ...state, error: messageOf(error) })
        }
      }

      async function upgrade() {
        setDialog({ kind: 'upgrade', busy: true, error: null })
        try {
          const value = await call('/upgrade', { confirm: true })
          setDialog(null)
          setBanner({ kind: 'upgrade', text: `已升级为 2.0，已备份为 ${value.backupFile}，共 ${value.upgradedCount} 条` })
          await loadSnapshot()
        } catch (error) {
          const text = messageOf(error)
          if (text === '数据已经是 2.0 格式') {
            setDialog(null)
            await loadSnapshot()
            return
          }
          setDialog({ kind: 'upgrade', busy: false, error: text })
        }
      }

      const handlers = {
        now,
        todos,
        childrenByParent,
        workspaceTitles,
        scopeKey,
        readOnly,
        readOnlyReason,
        tagCandidates,
        settings: snapshot.settings,
        selection: new Set(selectedIds),
        selectMode,
        focusId,
        highlightId,
        sessionErrors,
        canStartSession,
        completeOne,
        completeSelected,
        removeItem,
        openEdit,
        openCreate,
        openSource,
        openStartedSession,
        beginSession,
        openDuplicate,
        toggleSelected,
        toggleCollapseQuadrant,
        runWrite,
        setConfirmState,
        setBanner,
        requestFocus,
        completeReminder,
        snoozeReminder,
        openMenuId,
        setOpenMenuId
      }

      function toggleSelectMode() {
        setSelectMode(!selectMode)
        setSelectedIds([])
      }

      const topRowCollapsed = collapsedMap['urgent-important'] === true && collapsedMap['not-urgent-important'] === true
      const bottomRowCollapsed = collapsedMap['urgent-not-important'] === true && collapsedMap['not-urgent-not-important'] === true
      const gridClass = topRowCollapsed && bottomRowCollapsed
        ? 'tc-grid tc-grid-both-auto'
        : topRowCollapsed
          ? 'tc-grid tc-grid-first-auto'
          : bottomRowCollapsed
            ? 'tc-grid tc-grid-second-auto'
            : 'tc-grid'

      function onTabKeyDown(event) {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
        event.preventDefault()
        const index = TABS.findIndex((entry) => entry.id === tab)
        const step = event.key === 'ArrowRight' ? 1 : -1
        const next = TABS[(index + step + TABS.length) % TABS.length]
        setTab(next.id)
      }

      function patchConditions(patch) {
        setConditions((current) => normalizeConditions({ ...current, ...patch }))
      }

      const workspaceOptions = [
        h('option', { key: 'all', value: 'all' }, '全部工作区'),
        h('option', { key: 'none', value: 'none' }, '个人待办'),
        ...workspaces.map((workspace) => h('option', { key: workspace.workspaceId, value: workspace.workspaceId }, workspace.title))
      ]

      const workspaceId = scopeKey === 'all' || scopeKey === 'none' ? null : scopeKey
      const banners = []

      if (snapshot.error !== null) {
        banners.push(h(StatusBanner, {
          key: 'error',
          kind: 'error',
          text: snapshot.error,
          actions: [{ label: '关闭', onClick: clearError }]
        }))
      }

      if (readOnly) {
        banners.push(h(StatusBanner, {
          key: 'readonly',
          kind: 'warn',
          text: '数据格式为 1.0，升级后可用 2.0 功能',
          actions: [{ label: '升级', primary: true, onClick: () => setDialog({ kind: 'upgrade', busy: false, error: null }) }]
        }))
      }

      if (banner !== null) {
        const actions = banner.kind === 'import'
          ? [
            { label: '撤销导入', onClick: undoImport },
            { label: '关闭', onClick: () => setBanner(null) }
          ]
          : [{ label: '关闭', onClick: () => setBanner(null) }]
        banners.push(h(StatusBanner, {
          key: 'session',
          kind: banner.kind === 'error' ? 'error' : 'info',
          text: banner.text,
          error: banner.error,
          actions
        }))
      }

      const toolsMenu = toolsOpen
        ? h('div', { className: 'tc-menu', role: 'menu' },
          h('button', { className: 'tc-menu-item', role: 'menuitem', onClick: exportAll }, '导出全部数据'),
          h('button', { className: 'tc-menu-item', role: 'menuitem', onClick: copyJson }, '复制 JSON'),
          h('button', { className: 'tc-menu-item', role: 'menuitem', onClick: beginImport, disabled: readOnly }, '导入数据'),
          h('div', { className: 'tc-menu-note' }, '导入会整份替换当前数据，导入后可在本次会话内撤销')
        )
        : null

      const content = tab === 'quadrants'
        ? h('div', { className: 'tc-matrix' },
          h('div', { className: 'tc-axis tc-axis-y', 'aria-hidden': 'true' }, h('span', { className: 'tc-axis-arrow' }, '↑'), '重要'),
          h('div', { className: gridClass },
          QUADRANTS.map((quadrant) => h(QuadrantCell, {
            key: quadrant.id,
            quadrant,
            items: quadrantLists.get(quadrant.id) ?? [],
            collapsed: collapsedMap[quadrant.id] === true,
            onToggleCollapse: () => toggleCollapseQuadrant(quadrant.id),
            onDropItem: (id) => {
              if (readOnly) return
              runWrite(() => call('/setQuadrant', { ids: [id], quadrant: quadrant.id }))
            },
            selectMode,
            workspaceId,
            filtersActive: conditions.tags.length > 0 || conditions.quadrants.length > 0 || conditions.dueState !== 'all'
              || conditions.dueRange.kind !== 'any' || conditions.source !== 'all' || conditions.keyword !== '',
            onClearConditions: clearConditions,
            handlers
          }))
          ),
          h('div', { className: 'tc-axis tc-axis-x', 'aria-hidden': 'true' }, '紧急', h('span', { className: 'tc-axis-arrow' }, '→'))
        )
        : tab === 'today'
          ? h(TodayView, { groups: todayGroups, handlers, workspaceId })
          : tab === 'completed'
            ? h(CompletedList, {
              items: completedItems,
              handlers,
              range: doneRange,
              from: doneFrom,
              to: doneTo
            })
            : h(StatsView, {
              todos,
              scopeKey,
              settings: snapshot.settings,
              now
            })

      const showBatchBar = selectedIds.length > 0 && (tab === 'quadrants' || tab === 'today')

      return h('div', { className: 'tc-root' },
        h('div', { className: 'tc-page' },
        h(StyleSheet),
        h('div', { className: 'tc-shell' },
          h('header', { className: 'tc-header' },
            h('div', { className: 'tc-title' }, '待办中心'),
            h('div', { className: 'tc-header-spacer' }),
            h('button', {
              className: 'tc-button',
              onClick: () => setFeishuOpen(true),
              'aria-label': '飞书同步配置'
            }, '飞书同步'),
            h('select', {
              className: 'tc-select',
              value: scopeKey,
              onChange: (event) => setScopeKey(event.target.value),
              'aria-label': '工作区'
            }, workspaceOptions),
            h('button', { className: 'tc-button', onClick: closePanel, 'aria-label': '关闭待办中心' }, '关闭')
          ),
          h('div', { className: 'tc-tabs-row' },
            h('div', { className: 'tc-tabs', role: 'tablist', 'aria-label': '待办中心分区', onKeyDown: onTabKeyDown },
              TABS.map((entry) => h('button', {
                key: entry.id,
                className: 'tc-tab',
                role: 'tab',
                'aria-selected': tab === entry.id,
                tabIndex: tab === entry.id ? 0 : -1,
                onClick: () => setTab(entry.id)
              }, entry.label))
            ),
            h('div', { className: 'tc-tools-wrap' },
              h('button', {
                className: 'tc-button',
                'aria-haspopup': 'menu',
                'aria-expanded': toolsOpen,
                onClick: () => setToolsOpen(!toolsOpen)
              }, '工具'),
              toolsMenu
            )
          ),
          banners.length === 0 ? null : banners,
          tab === 'today'
            ? h(ReminderSection, {
              reminders: snapshot.reminders,
              readOnly,
              readOnlyReason,
              now,
              onComplete: completeReminder,
              onSnooze: snoozeReminder
            })
            : null,
          tab === 'quadrants' || tab === 'today'
            ? h(QuickAddBar, {
              workspaceId,
              readOnly,
              readOnlyReason,
              tagCandidates,
              handlers,
              onCreated: (id) => {
                setHighlightId(id)
                setFocusId(id)
              }
            })
            : null,
          tab === 'stats'
            ? null
            : h(FilterBar, {
              mode: tab === 'completed' ? 'done' : 'open',
              conditions,
              onPatch: patchConditions,
              tagCandidates,
              tagCounts,
              missingTags,
              presets: snapshot.filters,
              activePreset,
              presetModified,
              tagsOpen,
              presetOpen,
              setTagsOpen,
              setPresetOpen,
              readOnly,
              readOnlyReason,
              onApplyPreset: applyPreset,
              onRemovePreset: removePreset,
              onSavePreset: openPresetSave,
              selectMode,
              onToggleSelectMode: toggleSelectMode,
              onSelectAll: selectAllVisible,
              doneRange,
              doneFrom,
              doneTo,
              onRangeChange: setDoneRange,
              onFromChange: setDoneFrom,
              onToChange: setDoneTo
            }),
          h('div', { className: 'tc-tabpanel', 'data-tc-tab': tab }, content),
          showBatchBar
            ? h('div', { className: 'tc-batchbar' },
              h('span', null, `已选 ${selectedIds.length} 项`),
              h('button', { className: 'tc-button', onClick: () => setSelectedIds([]) }, '取消选择'),
              h('button', { className: 'tc-button tc-button-primary', onClick: completeSelected, disabled: readOnly }, '批量完成'),
              h('select', {
                className: 'tc-select',
                value: '',
                disabled: readOnly,
                onChange: (event) => {
                  if (event.target.value !== '') moveToQuadrant(event.target.value)
                },
                'aria-label': '批量改象限'
              },
                h('option', { value: '' }, '批量改象限…'),
                QUADRANTS.map((quadrant) => h('option', { key: quadrant.id, value: quadrant.id }, quadrant.name))
              ),
              readOnly ? h('span', { className: 'tc-hint' }, readOnlyReason) : null
            )
            : null
        ),
        h('input', {
          type: 'file',
          accept: 'application/json,.json',
          ref: fileRef,
          style: { display: 'none' },
          onChange: readImportFile,
          'aria-hidden': true,
          tabIndex: -1
        }),
        confirmState === null
          ? null
          : h(ConfirmDialog, {
            title: confirmState.title,
            text: confirmState.text,
            confirmLabel: confirmState.confirmLabel,
            onCancel: () => setConfirmState(null),
            onConfirm: async () => {
              const action = confirmState.run
              setConfirmState(null)
              await action()
            }
          })
        ),
        editor === null
          ? null
          : h(TodoEditorDrawer, {
            mode: editor.mode,
            item: editor.mode === 'edit' ? editor.item : null,
            quadrantId: editor.mode === 'create' ? editor.quadrant : editor.item.quadrant,
            trigger: editor.trigger,
            handlers,
            onClose: () => setEditor(null),
            onSave: async (patch, quadrant) => {
              if (editor.mode === 'create') {
                const created = await runWrite(() => call('/create', {
                  title: patch.title,
                  description: patch.description,
                  dueAt: patch.dueAt,
                  quadrant,
                  workspaceId,
                  source: { kind: 'manual' },
                  recurrence: patch.recurrence,
                  reminder: patch.reminder
                }))
                if (created === null) return
                for (const childTitle of patch.children) {
                  const child = await runWrite(() => call('/create', {
                    title: childTitle,
                    quadrant,
                    parentId: created.focusId
                  }))
                  if (child === null) return
                }
                setEditor(null)
                return
              }
              const value = await runWrite(() => call('/update', {
                id: editor.item.id,
                title: patch.title,
                description: patch.description,
                dueAt: patch.dueAt,
                recurrence: patch.recurrence,
                reminder: patch.reminder
              }))
              if (value === null) return
              // 象限不随 update 一起改，选中的象限与保存前不同时再单独发一次换格请求
              if (quadrant !== editor.item.quadrant) {
                const moved = await runWrite(() => call('/setQuadrant', { ids: [editor.item.id], quadrant }))
                if (moved === null) return
              }
              for (const childTitle of patch.children) {
                const created = await runWrite(() => call('/create', {
                  title: childTitle,
                  parentId: editor.item.id
                }))
                if (created === null) return
              }
              setEditor(null)
            }
          }),
        dialog === null ? null : renderDialog(),
        feishuOpen === false ? null : h(FeishuSyncDialog, { onClose: () => setFeishuOpen(false) })
      )

      function renderDialog() {
        if (dialog.kind === 'preset') {
          return h(PromptDialog, {
            title: dialog.mode === 'update' ? '更新当前预设' : '保存当前条件',
            label: '名称',
            value: dialog.name,
            error: dialog.error,
            maxLength: 40,
            placeholder: '1 至 40 字',
            confirmLabel: '保存',
            onChange: (value) => setDialog({ ...dialog, name: value, error: null }),
            onCancel: () => setDialog(null),
            onConfirm: savePreset
          })
        }
        if (dialog.kind === 'import') {
          return h(ImportDialog, {
            state: dialog,
            currentCount: todos.filter((item) => item.parentId === null && item.status === 'open').length,
            onCancel: () => setDialog(null),
            onConfirm: confirmImport
          })
        }
        if (dialog.kind === 'upgrade') {
          return h(ConfirmDialog, {
            title: '升级数据格式',
            text: '升级会先把当前文件备份为 todos.v1-<时间戳>.json，再把数据改写为 2.0 格式；已有条目的取值不变。',
            confirmLabel: dialog.busy === true ? '正在升级…' : '升级',
            error: dialog.error,
            busy: dialog.busy === true,
            onCancel: () => setDialog(null),
            onConfirm: upgrade
          })
        }
        return h(DuplicateRecurrenceDialog, {
          state: dialog,
          todos,
          onSearch: (value) => setDialog({ ...dialog, search: value }),
          onSelect: (targetId) => setDialog({ ...dialog, targetId }),
          onCancel: () => setDialog(null),
          onConfirm: confirmDuplicate
        })
      }
    }


    // ---------- 飞书同步 ----------

    // 状态 → 标签文案；ready 才算可用，expired/missing 都要引导登录
    function authBadge(user) {
      if (user === null || user === undefined) return { text: '未检测', tone: 'warn' }
      if (user.ready === true) return { text: '可用', tone: 'ok' }
      if (user.status === 'missing') return { text: '未登录', tone: 'warn' }
      return { text: user.status === 'expired' ? '已过期' : String(user.status), tone: 'warn' }
    }

    // 飞书同步配置：lark-cli 状态、扫码登录、四个象限对应的飞书清单
    function FeishuSyncDialog(props) {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [login, setLogin] = useState(null)
      const [lists, setLists] = useState(null)
      const [draft, setDraft] = useState({})
      const [busy, setBusy] = useState(null)
      const [note, setNote] = useState(null)

      const refresh = useCallback(async () => {
        try {
          const value = await call('/sync/status')
          setStatus(value)
          setDraft((current) => ({ ...(value.config?.lists ?? {}), ...current }))
          setError(null)
          return value
        } catch (failure) {
          setError(messageOf(failure))
          return null
        }
      }, [])

      const refreshLists = useCallback(async () => {
        try {
          const value = await call('/sync/tasklists')
          setLists(Array.isArray(value.items) ? value.items : [])
          return value
        } catch {
          setLists([])
          return null
        }
      }, [])

      useEffect(() => {
        refresh().then((value) => {
          if (value !== null && value.auth?.user?.ready === true) refreshLists()
        })
      }, [refresh, refreshLists])

      // 设备码登录：浏览器里确认后 lark-cli 在后台换 token，这里轮询结果
      useEffect(() => {
        if (login === null || login.ready === true) return undefined
        let cancelled = false
        const timer = setTimeout(async () => {
          try {
            const value = await call('/sync/login/poll', { deviceCode: login.deviceCode })
            if (cancelled === true) return
            if (value.ready === true) {
              setLogin({ ...login, ready: true, waiterState: value.waiterState })
              setNote('登录成功，已经读到飞书身份')
              await refresh()
              await refreshLists()
              return
            }
            setLogin({ ...login, waiterState: value.waiterState })
          } catch (failure) {
            if (cancelled === false) setNote(messageOf(failure))
          }
        }, 2500)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [login, refresh, refreshLists])

      async function guard(kind, task) {
        setBusy(kind)
        setNote(null)
        try {
          await task()
        } catch (failure) {
          setNote(messageOf(failure))
        } finally {
          setBusy(null)
        }
      }

      function startLogin() {
        return guard('login', async () => {
          const value = await call('/sync/login/start', {})
          setLogin({
            deviceCode: value.deviceCode,
            verificationUrl: value.verificationUrl,
            qrText: value.qrText === null || value.qrText === undefined ? null : value.qrText,
            ready: false,
            waiterState: 'pending'
          })
        })
      }

      function createLists() {
        return guard('create', async () => {
          const value = await call('/sync/tasklists/create', {})
          setDraft(value.config?.lists ?? {})
          setNote(`已创建 ${value.created?.length ?? 0} 个飞书清单`)
          await refresh()
          await refreshLists()
        })
      }

      function saveMapping() {
        return guard('save', async () => {
          const value = await call('/sync/config', { lists: draft })
          const missing = Array.isArray(value.missing) ? value.missing : []
          setNote(missing.length === 0 ? '已保存：四个象限都对应到飞书清单' : `已保存，还缺 ${missing.length} 个象限未选清单`)
          await refresh()
        })
      }

      function runNow(dryRun) {
        return guard(dryRun === true ? 'dry' : 'run', async () => {
          const value = await call('/sync/run', { dryRun })
          setNote(value.summary)
          await refresh()
        })
      }

      const cli = status === null ? null : status.cli
      const user = status === null || status.auth === null ? null : status.auth.user
      const config = status === null ? null : status.config
      const badge = authBadge(user)
      const options = lists === null ? [] : lists
      const lastRun = status === null ? null : status.lastRun

      const statusSection = h('div', { className: 'tc-sync-section' },
        h('div', { className: 'tc-sync-row' },
          h('span', { className: 'tc-sync-label' }, 'lark-cli'),
          cli === null
            ? h('span', { className: 'tc-sync-value' }, '检测中…')
            : h('span', { className: 'tc-sync-value' },
              cli.installed === false
                ? '未安装（npm install -g @larksuite/lark-cli）'
                : `${cli.version ?? '已安装'}${cli.path === null ? '' : ` · ${cli.path}`}`),
          cli !== null && cli.installed === true
            ? h('span', { className: 'tc-sync-badge tc-sync-badge-ok' }, '已安装')
            : null
        ),
        h('div', { className: 'tc-sync-row' },
          h('span', { className: 'tc-sync-label' }, '飞书账号'),
          h('span', { className: 'tc-sync-value' },
            user === null
              ? '检测中…'
              : `${user.userName ?? '未知用户'}${user.expiresAt === null ? '' : ` · 到期 ${String(user.expiresAt).slice(0, 10)}`}`),
          h('span', { className: `tc-sync-badge${badge.tone === 'ok' ? ' tc-sync-badge-ok' : ' tc-sync-badge-warn'}` }, badge.text)
        ),
        user !== null && user.ready === true && Array.isArray(user.missingScopes) && user.missingScopes.length > 0
          ? h('div', { className: 'tc-sync-note' }, `缺少权限：${user.missingScopes.join('、')}`)
          : null,
        error === null ? null : h('div', { className: 'tc-modal-error' }, error)
      )

      const loginSection = user !== null && user.ready === true && login === null
        ? null
        : h('div', { className: 'tc-sync-section' },
          h('div', { className: 'tc-sync-strong' }, login === null ? '登录飞书' : '等待授权'),
          h('div', { className: 'tc-sync-note' },
            login === null
              ? '点下面的按钮生成一次性授权链接，浏览器（或飞书扫码）确认后会自动回到这里。'
              : '在浏览器打开下面的链接完成确认；这个窗口会自动检测，不用手动刷新。'),
          login === null
            ? h('div', { className: 'tc-sync-actions' },
              h('button', { className: 'tc-button tc-button-primary', disabled: busy !== null, onClick: startLogin },
                busy === 'login' ? '正在生成…' : '生成飞书授权链接'))
            : h('div', { className: 'tc-sync-stack' },
              h('a', { className: 'tc-sync-url', href: login.verificationUrl, target: '_blank', rel: 'noreferrer' }, login.verificationUrl),
              login.qrText === null
                ? null
                : h('pre', { className: 'tc-sync-qr', 'aria-label': '授权二维码' }, login.qrText),
              login.ready === true
                ? h('div', { className: 'tc-sync-note' }, '已登录。')
                : h('div', { className: 'tc-sync-note' }, `等待确认…（状态：${login.waiterState ?? 'pending'}）`))
        )

      const mappingSection = h('div', { className: 'tc-sync-section' },
        h('div', { className: 'tc-sync-strong' }, '象限对应的飞书清单'),
        h('div', { className: 'tc-sync-note' },
          user !== null && user.ready === true
            ? '每个象限对应一个飞书任务清单；改动后点「保存映射」。'
            : '登录后这里会列出你账号下的飞书任务清单。'),
        QUADRANTS.map((quadrant) => {
          const current = typeof draft[quadrant.id] === 'string' ? draft[quadrant.id] : ''
          const known = options.some((item) => item.guid === current)
          return h('div', { className: 'tc-sync-row', key: quadrant.id },
            h('span', { className: 'tc-sync-label' }, `${quadrant.emoji} ${quadrant.name}`),
            h('select', {
              className: 'tc-select tc-sync-select',
              value: current,
              onChange: (event) => setDraft({ ...draft, [quadrant.id]: event.target.value }),
              'aria-label': `${quadrant.name} 对应的飞书清单`
            },
              h('option', { value: '' }, '未选择'),
              known || current === '' ? null : h('option', { value: current }, `${current}（当前）`),
              options.map((item) => h('option', { key: item.guid, value: item.guid }, item.name))
            )
          )
        }),
        h('div', { className: 'tc-sync-actions' },
          h('button', {
            className: 'tc-button',
            disabled: busy !== null || (user !== null && user.ready !== true),
            onClick: createLists
          }, busy === 'create' ? '创建中…' : '帮我创建四个清单'),
          h('button', { className: 'tc-button', disabled: busy !== null, onClick: saveMapping },
            busy === 'save' ? '保存中…' : '保存映射')
        )
      )

      const actionSection = h('div', { className: 'tc-sync-section' },
        h('div', { className: 'tc-sync-strong' }, '同步'),
        h('div', { className: 'tc-sync-note' },
          lastRun === null || lastRun.lastRunAt === null
            ? '还没同步过。预演只统计不写入，适合先看一遍会发生什么。'
            : `上次同步：${String(lastRun.lastRunAt).replace('T', ' ').slice(0, 19)} · 已映射 ${lastRun.mappedItems} 条`),
        h('div', { className: 'tc-sync-actions' },
          h('button', {
            className: 'tc-button',
            disabled: busy !== null || config === null || Object.keys(config.lists ?? {}).length === 0,
            onClick: () => runNow(true)
          }, busy === 'dry' ? '预演中…' : '立即预演'),
          h('button', {
            className: 'tc-button tc-button-primary',
            disabled: busy !== null || config === null || Object.keys(config.lists ?? {}).length === 0,
            onClick: () => runNow(false)
          }, busy === 'run' ? '同步中…' : '立即同步')
        ),
        lastRun !== null && Array.isArray(lastRun.logTail) && lastRun.logTail.length === 0
          ? null
          : h('pre', { className: 'tc-sync-log' }, (lastRun?.logTail ?? []).join('\n'))
      )

      return h(DialogFrame, {
        title: '飞书同步',
        width: 'wide',
        closed: props.onClose,
        children: h('div', { className: 'tc-sync-body' },
          statusSection,
          loginSection,
          mappingSection,
          actionSection,
          note === null ? null : h('div', { className: 'tc-sync-note' }, note)
        ),
        actions: h('button', { className: 'tc-button', onClick: props.onClose }, '关闭')
      })
    }

    // ---------- 状态条 ----------

    function StatusBanner(props) {
      const text = props.error === undefined || props.error === null ? props.text : `${props.text}\n${props.error}`
      return h('div', { className: `tc-banner tc-banner-${props.kind}` },
        h('div', { className: 'tc-banner-text' }, text),
        h('div', { className: 'tc-banner-actions' },
          props.actions.map((action) => h('button', {
            key: action.label,
            className: action.primary === true ? 'tc-button tc-button-primary' : 'tc-button',
            onClick: action.onClick
          }, action.label))
        )
      )
    }

    // ---------- 标签编辑 ----------

    function TagEditor(props) {
      const { tags, candidates, onChange, disabled, inputRef } = props
      const [text, setText] = useState('')
      const invalid = tags.length > 10 || tags.some((tag) => tag.length > 20)

      function add(raw) {
        if (disabled) return
        const value = raw.trim()
        if (value === '' || tags.includes(value)) return
        if (value.length > 20 || tags.length >= 10) return
        onChange([...tags, value])
        setText('')
      }

      const rest = candidates.filter((tag) => !tags.includes(tag))

      return h('div', { className: 'tc-field' },
        tags.length === 0
          ? null
          : h('div', { className: 'tc-tag-list' },
            tags.map((tag) => h('span', { key: tag, className: 'tc-tag' },
              tag,
              h('button', {
                className: 'tc-tag-x',
                onClick: () => onChange(tags.filter((value) => value !== tag)),
                disabled,
                'aria-label': `删除标签 ${tag}`
              }, '×')
            ))
          ),
        h('input', {
          className: 'tc-input',
          value: text,
          ref: inputRef,
          placeholder: '输入标签后回车',
          maxLength: 20,
          disabled,
          onChange: (event) => setText(event.target.value),
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            add(text)
          },
          'aria-label': '标签输入'
        }),
        rest.length === 0
          ? null
          : h('div', { className: 'tc-tag-list' },
            rest.slice(0, 20).map((tag) => h('button', {
              key: tag,
              className: 'tc-tag',
              onClick: () => add(tag),
              disabled
            }, tag))
          ),
        invalid ? h('div', { className: 'tc-parse-error' }, '标签最多 10 个，每个最多 20 字') : null
      )
    }

    // ---------- 快速录入 ----------

    const SYNTAX_GROUPS = [
      { name: '日期', values: '今天、明天、后天、大后天、周三、下周三、11月5日' },
      { name: '时刻', values: '14点、下午3点半、上午、中午、下午、傍晚、晚上' },
      { name: '象限', values: '#紧急重要、#重要、#紧急、#一般' }
    ]

    function QuickAddBar(props) {
      const { workspaceId, readOnly, readOnlyReason, tagCandidates, onCreated } = props
      const [text, setText] = useState('')
      const [preview, setPreview] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [helpOpen, setHelpOpen] = useState(false)
      const inputRef = useRef(null)
      const titleRef = useRef(null)

      useEffect(() => {
        if (preview === null) return
        if (titleRef.current !== null) titleRef.current.focus()
      }, [preview === null])

      function openPreview() {
        if (readOnly) return
        if (text.trim() === '') return
        const parsed = parseQuickInput(text, Date.now())
        setPreview({
          title: parsed.title,
          date: parsed.dueAt === null ? '' : dateInputOf(parsed.dueAt),
          time: parsed.dueAt === null ? '' : timeInputOf(parsed.dueAt),
          quadrant: parsed.quadrant,
          tags: parsed.tags,
          matched: parsed.matched,
          notes: parsed.notes
        })
        setError(parsed.title.trim() === '' ? '标题不能为空' : null)
      }

      function closePreview() {
        setPreview(null)
        setError(null)
        if (inputRef.current !== null) inputRef.current.focus()
      }

      async function submit() {
        if (preview === null || busy || readOnly) return
        const title = preview.title.trim()
        if (title === '') {
          setError('标题不能为空')
          return
        }
        const dueAt = preview.date === ''
          ? null
          : toIso(preview.time === '' ? preview.date : `${preview.date}T${preview.time}`, preview.time === '')
        setBusy(true)
        try {
          const value = await call('/create', {
            title,
            description: '',
            quadrant: preview.quadrant,
            dueAt,
            workspaceId,
            source: { kind: 'manual' },
            reminder: null,
            recurrence: null
          })
          applyDelta(value)
          store.error = null
          publish()
          const created = (value.upserted ?? []).find((entry) => entry.id === value.focusId) ?? (value.upserted ?? [])[0]
          setText('')
          setPreview(null)
          setError(null)
          if (created !== undefined) onCreated(created.id)
          if (inputRef.current !== null) inputRef.current.focus()
        } catch (submitError) {
          setError(messageOf(submitError))
        } finally {
          setBusy(false)
        }
      }

      const remaining = QUICK_MAX - text.length

      return h('div', {
        className: 'tc-quick',
        onKeyDown: (event) => {
          if (event.key === 'Escape' && preview !== null) {
            event.stopPropagation()
            closePreview()
            return
          }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            submit()
          }
        }
      },
        h('div', { className: 'tc-quick-field' },
          h('input', {
            className: 'tc-quick-input',
            ref: inputRef,
            value: text,
            maxLength: QUICK_MAX,
            placeholder: readOnly ? readOnlyReason : '一行写完：明天下午交报告 #重要',
            disabled: readOnly,
            title: readOnly ? readOnlyReason : undefined,
            onChange: (event) => {
              setText(event.target.value)
              if (preview !== null) setPreview(null)
              setError(null)
            },
            onKeyDown: (event) => {
              if (event.key !== 'Enter' || event.ctrlKey || event.metaKey) return
              event.preventDefault()
              openPreview()
            },
            'aria-label': '快速录入'
          }),
          text.length >= 180 ? h('span', { className: 'tc-quick-counter' }, `剩余 ${remaining} 字`) : null,
          h('button', {
            className: 'tc-quick-help',
            type: 'button',
            'aria-label': '快速录入语法说明',
            onMouseEnter: () => setHelpOpen(true),
            onMouseLeave: () => setHelpOpen(false),
            onFocus: () => setHelpOpen(true),
            onBlur: () => setHelpOpen(false)
          }, '?')
        ),
        helpOpen
          ? h('div', { className: 'tc-quick-syntax' },
            SYNTAX_GROUPS.map((group) => h('div', { key: group.name, className: 'tc-syntax-group' },
              h('span', { className: 'tc-syntax-name' }, group.name),
              h('span', { className: 'tc-syntax-values' }, group.values)
            ))
          )
          : null,
        preview === null
          ? null
          : h('div', { className: 'tc-parse' },
            h('div', { className: 'tc-parse-fields' },
              preview.matched.length === 0
                ? null
                : h('div', { className: 'tc-parse-matched' },
                  h('span', null, '已识别：'),
                  preview.matched.map((fragment, index) => h('span', { key: `${fragment}-${index}`, className: 'tc-parse-chip' }, fragment))
                ),
              preview.notes.map((note) => h('div', { key: note, className: 'tc-parse-note' }, note)),
              h('div', { className: 'tc-parse-row' },
                h('div', { className: 'tc-parse-label' }, '标题'),
                h('div', { className: 'tc-parse-control' },
                  h('input', {
                    className: 'tc-input',
                    ref: titleRef,
                    value: preview.title,
                    maxLength: 200,
                    onChange: (event) => {
                      setPreview({ ...preview, title: event.target.value })
                      setError(null)
                    },
                    'aria-label': '快速录入标题'
                  })
                )
              ),
              h('div', { className: 'tc-parse-row' },
                h('div', { className: 'tc-parse-label' }, '截止时间'),
                h('div', { className: 'tc-parse-control' },
                  h('input', {
                    className: 'tc-input',
                    type: 'date',
                    value: preview.date,
                    onChange: (event) => setPreview({ ...preview, date: event.target.value }),
                    'aria-label': '快速录入截止日期'
                  }),
                  h('input', {
                    className: 'tc-input',
                    type: 'time',
                    value: preview.time,
                    onChange: (event) => setPreview({ ...preview, time: event.target.value }),
                    'aria-label': '快速录入截止时刻'
                  }),
                  h('button', {
                    className: 'tc-link',
                    type: 'button',
                    onClick: () => setPreview({ ...preview, date: '', time: '' })
                  }, '清除时间')
                )
              ),
              h('div', { className: 'tc-parse-row' },
                h('div', { className: 'tc-parse-label' }, '象限'),
                h('div', { className: 'tc-parse-control' },
                  h('select', {
                    className: 'tc-select',
                    value: preview.quadrant,
                    onChange: (event) => setPreview({ ...preview, quadrant: event.target.value }),
                    'aria-label': '快速录入象限'
                  }, QUADRANTS.map((quadrant) => h('option', { key: quadrant.id, value: quadrant.id }, quadrant.name)))
                )
              ),
              error === null ? null : h('div', { className: 'tc-parse-error' }, error)
            ),
            h('div', { className: 'tc-parse-actions' },
              h('button', {
                className: 'tc-button tc-button-primary',
                onClick: submit,
                disabled: busy || readOnly,
                title: readOnly ? readOnlyReason : undefined
              }, busy ? '正在添加…' : '添加'),
              h('button', { className: 'tc-button', onClick: closePreview }, '取消')
            )
          )
      )
    }

    // ---------- 筛选区 ----------

    function FilterBar(props) {
      const {
        mode, conditions, onPatch, tagCandidates, tagCounts, missingTags, presets, activePreset,
        presetModified, readOnly, readOnlyReason, onApplyPreset, onRemovePreset, onSavePreset,
        selectMode, onToggleSelectMode, onSelectAll,
        doneRange, doneFrom, doneTo, onRangeChange, onFromChange, onToChange,
        tagsOpen, presetOpen, setTagsOpen, setPresetOpen
      } = props
      const [tagSearch, setTagSearch] = useState('')

      function toggleTag(tag) {
        const has = conditions.tags.includes(tag)
        onPatch({ tags: has ? conditions.tags.filter((value) => value !== tag) : [...conditions.tags, tag] })
      }

      // Esc 先收起筛选区自己弹出的浮层，浮层都关着时交给页面收起面板
      function onFilterKeyDown(event) {
        if (event.key !== 'Escape') return
        if (!tagsOpen && !presetOpen) return
        event.stopPropagation()
        setTagsOpen(false)
        setPresetOpen(false)
      }

      const filteredTags = tagCandidates.filter((tag) => tagSearch === '' || tag.includes(tagSearch))
      const tagPopover = h('div', { className: 'tc-pop' },
        tagCandidates.length > 200
          ? h('input', {
            className: 'tc-input',
            placeholder: '查找标签',
            value: tagSearch,
            onChange: (event) => setTagSearch(event.target.value),
            'aria-label': '查找标签'
          })
          : null,
        filteredTags.length === 0
          ? h('div', { className: 'tc-pop-empty' }, '还没有标签')
          : filteredTags.map((tag) => {
            const checked = conditions.tags.includes(tag)
            return h('button', {
              key: tag,
              className: 'tc-pop-row',
              role: 'menuitemcheckbox',
              'aria-checked': checked,
              onClick: () => toggleTag(tag)
            },
              h('span', { style: { width: '12px', textAlign: 'center' } }, checked ? '✓' : ''),
              h('span', null, tag),
              h('span', { className: 'tc-pop-count' }, String(tagCounts[tag] ?? 0))
            )
          }),
        h('div', { className: 'tc-pop-foot' },
          h('span', null, `已选 ${conditions.tags.length} 个`),
          h('button', { className: 'tc-link', onClick: () => onPatch({ tags: [] }) }, '清除')
        )
      )

      const presetPanel = h('div', { className: 'tc-preset-panel' },
        presetModified
          ? h('div', { className: 'tc-pop-foot' },
            h('button', { className: 'tc-link', onClick: () => onSavePreset('update') }, '更新当前预设'),
            h('button', { className: 'tc-link', onClick: () => onSavePreset('create') }, '另存为新预设')
          )
          : null,
        presets.length === 0
          ? h('div', { className: 'tc-pop-empty' }, '尚无保存的筛选条件')
          : presets.map((preset) => h('div', { key: preset.id, className: 'tc-preset-row' },
            h('button', {
              className: 'tc-preset-name',
              onClick: () => {
                onApplyPreset(preset)
                setPresetOpen(false)
              }
            }, `${preset.name}${activePreset !== null && activePreset.id === preset.id && presetModified ? '（已修改）' : ''}`),
            h('button', {
              className: 'tc-icon-button',
              onClick: () => {
                setPresetOpen(false)
                onRemovePreset(preset)
              },
              'aria-label': `删除预设 ${preset.name}`
            }, iconSvg('trash', 14))
          )),
        h('div', { className: 'tc-pop-foot' },
          h('button', {
            className: 'tc-link',
            disabled: readOnly || presets.length >= 20,
            onClick: () => {
              setPresetOpen(false)
              onSavePreset('create')
            }
          }, '保存当前条件'),
          presets.length >= 20 ? h('span', null, '最多保存 20 个筛选条件') : null
        )
      )

      return h('div', { className: 'tc-filterbar', onKeyDown: onFilterKeyDown },
        h('input', {
          className: 'tc-input',
          placeholder: '搜索标题与描述',
          value: conditions.keyword,
          maxLength: 100,
          onChange: (event) => onPatch({ keyword: event.target.value }),
          'aria-label': '搜索标题与描述'
        }),
        mode === 'open'
          ? h('select', {
            className: 'tc-select',
            value: conditions.dueState,
            onChange: (event) => onPatch({ dueState: event.target.value }),
            'aria-label': '逾期状态'
          },
            h('option', { value: 'all' }, '全部逾期状态'),
            h('option', { value: 'overdue' }, '已逾期'),
            h('option', { value: 'notOverdue' }, '未逾期'),
            h('option', { value: 'noDue' }, '无截止时间')
          )
          : h('select', {
            className: 'tc-select',
            value: doneRange,
            onChange: (event) => onRangeChange(event.target.value),
            'aria-label': '完成时间范围'
          },
            h('option', { value: 'today' }, '今天'),
            h('option', { value: 'week' }, '本周'),
            h('option', { value: 'month' }, '本月'),
            h('option', { value: 'custom' }, '自定义'),
            h('option', { value: 'all' }, '全部')
          ),
        mode === 'open'
          ? h('select', {
            className: 'tc-select',
            value: conditions.dueRange.kind,
            onChange: (event) => {
              const kind = event.target.value
              onPatch({ dueRange: { kind, from: kind === 'range' ? (conditions.dueRange.from ?? '') : null, to: kind === 'range' ? (conditions.dueRange.to ?? '') : null } })
            },
            'aria-label': '截止范围'
          },
            h('option', { value: 'any' }, '截止时间不限'),
            h('option', { value: 'today' }, '今天到期'),
            h('option', { value: 'week' }, '本周到期'),
            h('option', { value: 'range' }, '自定义范围')
          )
          : null,
        mode === 'open' && conditions.dueRange.kind === 'range'
          ? h('input', {
            className: 'tc-input',
            type: 'date',
            value: conditions.dueRange.from ?? '',
            onChange: (event) => onPatch({ dueRange: { ...conditions.dueRange, from: event.target.value } }),
            'aria-label': '截止时间起点'
          })
          : null,
        mode === 'open' && conditions.dueRange.kind === 'range'
          ? h('input', {
            className: 'tc-input',
            type: 'date',
            value: conditions.dueRange.to ?? '',
            onChange: (event) => onPatch({ dueRange: { ...conditions.dueRange, to: event.target.value } }),
            'aria-label': '截止时间终点'
          })
          : null,
        mode === 'done' && doneRange === 'custom'
          ? h('input', {
            className: 'tc-input',
            type: 'date',
            value: doneFrom,
            onChange: (event) => onFromChange(event.target.value),
            'aria-label': '完成时间起点'
          })
          : null,
        mode === 'done' && doneRange === 'custom'
          ? h('input', {
            className: 'tc-input',
            type: 'date',
            value: doneTo,
            onChange: (event) => onToChange(event.target.value),
            'aria-label': '完成时间终点'
          })
          : null,
        h('select', {
          className: 'tc-select',
          value: conditions.source,
          onChange: (event) => onPatch({ source: event.target.value }),
          'aria-label': '来源'
        },
          h('option', { value: 'all' }, '全部来源'),
          h('option', { value: 'manual' }, '手动创建'),
          h('option', { value: 'conversation' }, '来自会话')
        ),
        h('div', { className: 'tc-filter-wrap' },
          h('button', {
            className: 'tc-filter-btn',
            'aria-expanded': presetOpen,
            onClick: () => {
              setPresetOpen(!presetOpen)
              setTagsOpen(false)
            }
          }, activePreset === null || presetModified ? '预设' : `预设 · ${activePreset.name}`),
          presetOpen ? presetPanel : null
        ),
        mode === 'open'
          ? h('button', {
            className: 'tc-filter-btn',
            'aria-pressed': selectMode,
            onClick: onToggleSelectMode
          }, selectMode ? '退出多选' : '多选')
          : null,
        mode === 'open' && selectMode
          ? h('button', { className: 'tc-filter-btn', onClick: onSelectAll }, '全选当前筛选结果')
          : null,
        missingTags.length === 0
          ? null
          : h('div', { className: 'tc-filter-note' }, `以下标签已无匹配：${missingTags.join('、')}`)
      )
    }

    // ---------- 今日页提醒区 ----------

    function ReminderSection(props) {
      const { reminders, readOnly, readOnlyReason, now, onComplete, onSnooze } = props
      const items = reminders.slice(0, REMINDER_LIMIT)
      if (items.length === 0) return null

      return h('section', { className: 'tc-reminder', 'aria-label': '已到提醒时间的待办' },
        h('div', { className: 'tc-reminder-head' }, `${items.length} 条待办已到提醒时间`),
        h('div', { className: 'tc-reminder-list' },
          items.map((item) => {
            const due = item.dueAt === null ? null : Date.parse(item.dueAt)
            const minutes = typeof item.minutesUntilDue === 'number'
              ? item.minutesUntilDue
              : (due === null ? 0 : Math.round((due - now) / 60000))
            const when = minutes < 0 ? `已超期 ${Math.abs(minutes)} 分钟` : `还有 ${minutes} 分钟`
            return h('div', { key: item.id, className: 'tc-reminder-row' },
              h('span', { className: 'tc-reminder-title', title: item.title }, item.title),
              h('span', { className: 'tc-reminder-when' }, `截止 ${formatClock(item.dueAt)} · ${when}`),
              h('div', { className: 'tc-reminder-actions' },
                h('button', {
                  className: 'tc-button tc-button-small',
                  onClick: () => onComplete(item),
                  disabled: readOnly,
                  title: readOnly ? readOnlyReason : undefined
                }, '完成'),
                h('button', {
                  className: 'tc-button tc-button-small',
                  onClick: () => onSnooze(item),
                  disabled: readOnly,
                  title: readOnly ? readOnlyReason : undefined
                }, '稍后 10 分钟')
              )
            )
          })
        )
      )
    }

    // ---------- 今日视图 ----------

    function TodayView(props) {
      const { groups, handlers } = props
      const [collapsed, setCollapsed] = useState(() => {
        const map = {}
        for (const section of TODAY_SECTIONS) map[section.id] = section.open === false
        return map
      })

      return h('div', { className: 'tc-today' },
        TODAY_SECTIONS.map((section) => {
          const items = groups.get(section.id) ?? []
          const open = collapsed[section.id] !== true
          const bodyId = `tc-section-body-${section.id}`
          return h('section', { key: section.id, className: 'tc-section', 'data-tc-section': section.id },
            h('button', {
              className: 'tc-section-head',
              'aria-expanded': open,
              'aria-controls': bodyId,
              onClick: () => setCollapsed({ ...collapsed, [section.id]: open })
            },
              h('span', null, section.name),
              h('span', { className: 'tc-section-count' }, `· ${items.length} 项`),
              h('span', { className: 'tc-section-arrow' }, iconSvg('down', 16))
            ),
            open
              ? h('div', { id: bodyId, className: 'tc-card-flow' },
                items.length === 0
                  ? h('div', { className: 'tc-section-empty' }, '暂无')
                  : items.map((item) => h(TodoCard, {
                    key: item.id,
                    item,
                    children: handlers.childrenByParent.get(item.id) ?? [],
                    selected: handlers.selection === undefined ? false : handlers.selection.has(item.id),
                    selectMode: handlers.selectMode === true,
                    draggable: false,
                    handlers
                  }))
              )
              : null
          )
        })
      )
    }

    // ---------- 统计 ----------

    function formatDayOfTime(time) {
      const date = new Date(time)
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    function DistributionPanel(props) {
      const { title, counts, percents, total } = props
      return h('div', { className: 'tc-panel' },
        h('div', { className: 'tc-panel-head' },
          h('span', null, title),
          h('span', { className: 'tc-panel-note' }, `共 ${total} 项`)
        ),
        QUADRANTS.map((quadrant, index) => {
          const count = counts[quadrant.id]
          const percent = percents[index]
          const width = total === 0 ? 0 : Math.round((count / total) * 100)
          return h('div', { key: quadrant.id, className: 'tc-dist-row', 'data-tc-quadrant': quadrant.id },
            h('span', { className: 'tc-dist-label' },
              h('span', { className: 'tc-qchip-dot' }),
              quadrant.name
            ),
            h('div', { className: 'tc-dist-track' },
              count === 0 ? null : h('div', { className: 'tc-dist-fill', style: { width: `${Math.max(width, 2)}%` } })
            ),
            h('span', { className: 'tc-dist-value' }, `${count} · ${percent === null ? '—' : `${percent}%`}`)
          )
        })
      )
    }

    function StatsView(props) {
      const { todos, scopeKey, settings, now } = props
      const [rangeKind, setRangeKind] = useState(() => {
        const value = settings.statsRange
        return value === 'month' || value === 'quarter' || value === 'custom' ? value : 'week'
      })
      const [from, setFrom] = useState('')
      const [to, setTo] = useState('')

      const stats = useMemo(
        () => computeStats({ todos, now, scopeKey, kind: rangeKind, fromValue: from, toValue: to }),
        [todos, now, scopeKey, rangeKind, from, to]
      )

      function onRangeKeyDown(event) {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
        event.preventDefault()
        const index = STATS_RANGES.findIndex((entry) => entry.id === rangeKind)
        const step = event.key === 'ArrowRight' ? 1 : -1
        setRangeKind(STATS_RANGES[(index + step + STATS_RANGES.length) % STATS_RANGES.length].id)
      }

      const rangeRow = h('div', { className: 'tc-stats-range' },
        h('div', { className: 'tc-seg', role: 'group', 'aria-label': '统计区间', onKeyDown: onRangeKeyDown },
          STATS_RANGES.map((entry) => h('button', {
            key: entry.id,
            className: 'tc-seg-btn',
            'aria-pressed': rangeKind === entry.id,
            onClick: () => setRangeKind(entry.id)
          }, entry.label))
        ),
        rangeKind === 'custom'
          ? h('input', {
            className: 'tc-input',
            type: 'date',
            value: from,
            onChange: (event) => setFrom(event.target.value),
            'aria-label': '统计开始日期'
          })
          : null,
        rangeKind === 'custom'
          ? h('input', {
            className: 'tc-input',
            type: 'date',
            value: to,
            onChange: (event) => setTo(event.target.value),
            'aria-label': '统计结束日期'
          })
          : null,
        stats.error === undefined
          ? h('span', { className: 'tc-stats-range-note' }, `统计范围为 ${formatDayOfTime(stats.from)} 至 ${formatDayOfTime(stats.to)}`)
          : null
      )

      if (stats.error !== undefined) {
        return h('div', { className: 'tc-stats' },
          rangeRow,
          h('div', { className: 'tc-parse-error' }, stats.error)
        )
      }

      const ratioText = stats.overdueDenominator === 0
        ? '—'
        : `${Math.round((stats.overdueNumerator / stats.overdueDenominator) * 1000) / 10}%`
      const ratioNote = stats.overdueDenominator === 0
        ? '分子 0 / 分母 0；分母为区间内完成且有截止时间的条目。区间内没有带截止时间的已完成条目'
        : `分子 ${stats.overdueNumerator} / 分母 ${stats.overdueDenominator}；分母为区间内完成且有截止时间的条目`

      const maxWeekly = Math.max(1, ...stats.weeklyDone.map((entry) => entry.count))

      return h('div', { className: 'tc-stats' },
        rangeRow,
        stats.doneCount === 0 ? h('div', { className: 'tc-stats-note' }, '该区间没有完成记录') : null,
        h('div', { className: 'tc-stat-grid' },
          h('div', { className: 'tc-stat-card' },
            h('span', { className: 'tc-stat-value' }, String(stats.doneCount)),
            h('span', { className: 'tc-stat-label' }, '本区间完成的顶层待办')
          ),
          h('div', { className: 'tc-stat-card' },
            h('span', { className: 'tc-stat-value' }, ratioText),
            h('span', { className: 'tc-stat-label' }, ratioNote)
          )
        ),
        h(DistributionPanel, {
          title: '当前未完成',
          counts: stats.openByQuadrant,
          percents: stats.openPercent,
          total: stats.openTotal
        }),
        h('div', { className: 'tc-stats-note' }, `其中已逾期 ${stats.openOverdueCount} 项`),
        h(DistributionPanel, {
          title: '本区间已完成',
          counts: stats.doneByQuadrant,
          percents: stats.donePercent,
          total: stats.doneTotal
        }),
        h('div', { className: 'tc-panel' },
          h('div', { className: 'tc-panel-head' },
            h('span', null, '最近 8 周完成数'),
            h('span', { className: 'tc-panel-note' }, '截止到本周')
          ),
          h('div', { className: 'tc-weeks' },
            stats.weeklyDone.map((entry) => {
              const label = formatDayOfTime(entry.weekStart).slice(5)
              return h('div', {
                key: entry.weekStart,
                className: 'tc-week-col',
                'aria-label': `${label} 当周完成 ${entry.count} 项`
              },
                h('span', { className: 'tc-week-count' }, String(entry.count)),
                h('div', {
                  className: 'tc-week-bar',
                  style: { height: `${Math.max(2, Math.round((entry.count / maxWeekly) * 96))}px` }
                }),
                h('span', { className: 'tc-week-label' }, label)
              )
            })
          )
        ),
        h('div', { className: 'tc-stats-note' }, '统计只计入顶层待办，子待办不计入。')
      )
    }

    // ---------- 四象限方格 ----------

    function QuadrantCell(props) {
      const {
        quadrant, items, collapsed, onToggleCollapse, onDropItem,
        selectMode, workspaceId, filtersActive, onClearConditions, handlers
      } = props
      const [dropActive, setDropActive] = useState(false)
      const bodyId = `tc-body-${quadrant.id}`
      const readOnly = handlers.readOnly === true
      const cellClass = [
        'tc-cell',
        collapsed ? 'tc-cell-collapsed' : '',
        dropActive ? 'tc-cell-drop' : ''
      ].filter((value) => value !== '').join(' ')

      return h('section', {
        className: cellClass,
        'data-tc-quadrant': quadrant.id,
        onDragOver: (event) => {
          if (readOnly) return
          event.preventDefault()
          setDropActive(true)
        },
        onDragLeave: () => setDropActive(false),
        onDrop: (event) => {
          event.preventDefault()
          setDropActive(false)
          const id = event.dataTransfer.getData('text/plain')
          if (id !== '') onDropItem(id)
        },
        'aria-label': quadrant.name
      },
        h('div', { className: 'tc-cell-head' },
          h('span', { className: 'tc-cell-emoji', 'aria-hidden': 'true' }, quadrant.emoji),
          h('span', { className: 'tc-cell-name' }, quadrant.name),
          h('span', { className: 'tc-cell-level' }, quadrant.level),
          h('span', { className: 'tc-cell-count' }, `· ${items.length} 项`),
          h('div', { className: 'tc-spacer' }),
          h('button', {
            className: 'tc-button tc-button-small',
            onClick: onToggleCollapse,
            disabled: readOnly,
            title: readOnly ? handlers.readOnlyReason : undefined,
            'aria-expanded': !collapsed,
            'aria-controls': bodyId,
            'aria-label': collapsed ? `展开${quadrant.name}` : `收起${quadrant.name}`
          }, collapsed ? '展开' : '收起'),
          h('button', {
            className: 'tc-button tc-button-small',
            onClick: () => handlers.openCreate(quadrant.id),
            disabled: readOnly,
            title: readOnly ? handlers.readOnlyReason : undefined,
            'aria-label': `在${quadrant.name}添加待办`
          }, '添加')
        ),
        collapsed
          ? null
          : h('div', {
            className: 'tc-cell-body',
            id: bodyId,
            onScroll: (event) => {
              event.currentTarget.dataset.tcScrolled = event.currentTarget.scrollTop > 0 ? '1' : '0'
            }
          },
            items.length === 0
              ? (filtersActive
                ? h('div', { className: 'tc-section-empty' },
                  '当前筛选下没有待办',
                  h('button', { className: 'tc-link', onClick: onClearConditions }, '清除全部条件')
                )
                : h('button', {
                  className: 'tc-empty',
                  onClick: () => handlers.openCreate(quadrant.id),
                  disabled: readOnly,
                  title: readOnly ? handlers.readOnlyReason : undefined
                }, '暂无待办'))
              : items.map((item) => h(TodoCard, {
                key: item.id,
                item,
                children: handlers.childrenByParent.get(item.id) ?? [],
                selected: handlers.selection.has(item.id),
                selectMode,
                draggable: !readOnly,
                handlers
              }))
          )
      )
    }

    // ---------- 待办卡片 ----------

    function TodoCard(props) {
      const { item, children, selected, selectMode, draggable, handlers } = props
      const menuOpen = handlers.openMenuId === item.id
      function setMenuOpen(open) {
        handlers.setOpenMenuId(open ? item.id : null)
      }
      const readOnly = handlers.readOnly === true
      const overdue = isOverdue(item, handlers.now)
      const highlighted = handlers.highlightId === item.id
      const sessionError = handlers.sessionErrors[item.id]
      const classes = [
        'tc-card',
        selected ? 'tc-card-selected' : '',
        highlighted ? 'tc-card-highlight' : '',
        overdue ? 'tc-card-overdue' : '',
        sessionError === undefined ? '' : 'tc-card-has-error'
      ].filter((value) => value !== '').join(' ')
      const hasChildren = children.length > 0
      const childTitles = children.map((child) => child.title).join('、')

      return h('article', {
        className: classes,
        'data-tc-todo-id': item.id,
        'data-tc-card-quadrant': item.quadrant,
        draggable: draggable === true && selectMode !== true,
        onDragStart: (event) => {
          event.dataTransfer.setData('text/plain', item.id)
          event.dataTransfer.effectAllowed = 'move'
        },
        onKeyDown: (event) => {
          if (event.key === 'Escape') setMenuOpen(false)
        }
      },
        h('div', { className: 'tc-card-main' },
          h('div', { className: 'tc-check-slot' },
            h('button', {
              className: 'tc-check',
              'aria-pressed': selectMode === true ? selected : undefined,
              'aria-label': selectMode === true
                ? (selected ? `取消选择「${item.title}」` : `选择「${item.title}」`)
                : `完成「${item.title}」`,
              title: readOnly ? handlers.readOnlyReason : (selectMode === true ? '选择待办' : '标记完成'),
              disabled: readOnly,
              onClick: selectMode === true
                ? () => handlers.toggleSelected(item.id)
                : () => handlers.completeOne(item)
            }, selectMode === true && selected ? '✓' : '')
          ),
          h('div', { className: 'tc-card-head' },
            h('button', {
              className: 'tc-card-title-button',
              onClick: () => handlers.openEdit(item),
              disabled: readOnly,
              title: readOnly ? handlers.readOnlyReason : (item.description === '' ? item.title : `${item.title}\n${item.description}`)
            },
              h('span', { className: 'tc-card-dot', 'aria-hidden': true }),
              h('span', { className: 'tc-card-title' }, item.title)
            ),
            h('div', { className: 'tc-card-marks' },
              item.description === ''
                ? null
                : h('span', { className: 'tc-card-mark', title: item.description }, '描述'),
              hasChildren
                ? h('button', {
                  className: 'tc-card-mark tc-card-mark-button',
                  onClick: () => handlers.openEdit(item),
                  disabled: readOnly,
                  title: childTitles,
                  'aria-label': `查看「${item.title}」的子待办`
                }, `${children.filter((child) => child.status === 'done').length}/${children.length}`)
                : null,
              item.recurrence === null
                ? null
                : h('span', { className: 'tc-card-mark', title: recurrenceText(item.recurrence) }, '重复'),
              item.source.kind === 'conversation'
                ? h('button', {
                  className: 'tc-mark tc-mark-session',
                  onClick: () => handlers.openSource(item),
                  title: '打开来源会话'
                }, '来自会话')
                : null,
              item.startedSessionId === null
                ? null
                : h('button', {
                  className: 'tc-mark tc-mark-session',
                  onClick: () => handlers.openStartedSession(item),
                  title: '打开关联会话'
                }, '已发起会话')
            )
          ),
          h('div', { className: 'tc-card-side' },
            h('span', {
              className: overdue ? 'tc-card-time tc-card-time-late' : 'tc-card-time',
              'data-tc-card-time': '1'
            }, countdownText(item, handlers.now)),
            h('div', { className: 'tc-card-actions' },
              handlers.canStartSession === true && typeof handlers.beginSession === 'function'
                ? h('button', {
                  className: 'tc-icon-button',
                  onClick: () => handlers.beginSession(item),
                  disabled: readOnly,
                  title: item.startedSessionId === null ? '发起会话' : '已有会话，再次发起会替换标记',
                  'aria-label': `发起会话：${item.title}`
                }, iconSvg('chat', 14))
                : null,
              h('button', {
                className: 'tc-icon-button',
                onClick: () => setMenuOpen(!menuOpen),
                'aria-label': `更多操作：${item.title}`,
                'aria-expanded': menuOpen,
                title: '更多操作'
              }, iconSvg('more', 14))
            )
          )
        ),
        sessionError === undefined
          ? null
          : h('div', { className: 'tc-card-error' }, sessionError),
        menuOpen
          ? h('div', { className: 'tc-menu', role: 'menu' },
            h('button', {
              className: 'tc-menu-item',
              role: 'menuitem',
              onClick: () => {
                setMenuOpen(false)
                handlers.openEdit(item)
              },
              disabled: readOnly
            }, '编辑'),
            h('button', {
              className: 'tc-menu-item',
              role: 'menuitem',
              onClick: () => {
                setMenuOpen(false)
                handlers.openDuplicate(item)
              },
              disabled: readOnly || item.recurrence === null,
              title: item.recurrence === null ? '该待办没有重复设置' : '把重复设置复制到另一条待办'
            }, '复制重复设置'),
            h('button', {
              className: 'tc-menu-item',
              role: 'menuitem',
              onClick: () => {
                setMenuOpen(false)
                handlers.removeItem(item)
              },
              disabled: readOnly
            }, '删除')
          )
          : null
      )
    }

    function recurrenceText(rule) {
      if (rule === null || rule === undefined) return ''
      const unit = rule.freq === 'daily' ? '天' : rule.freq === 'weekly' ? '周' : '月'
      const base = rule.interval === 1 ? `每${unit}` : `每 ${rule.interval} ${unit}`
      const tail = rule.until === null ? '' : `，至 ${formatDay(rule.until)}`
      return `${base}重复${tail}`
    }

    // ---------- 方格内联编辑器 ----------

    const REMINDER_CHOICES = [
      { value: '', name: '不提醒' },
      { value: '0', name: '准时' },
      { value: '5', name: '提前 5 分钟' },
      { value: '15', name: '提前 15 分钟' },
      { value: '30', name: '提前 30 分钟' },
      { value: '60', name: '提前 1 小时' },
      { value: '1440', name: '提前 1 天' }
    ]

    const FREQ_CHOICES = [
      { value: '', name: '不重复' },
      { value: 'daily', name: '按天' },
      { value: 'weekly', name: '按周' },
      { value: 'monthly', name: '按月' }
    ]

    let childRowSeq = 0

    function useEditorFields(item, settings) {
      const [title, setTitle] = useState(item === null ? '' : item.title)
      const [description, setDescription] = useState(item === null ? '' : item.description)
      const [dateText, setDateText] = useState(dateInputOf(item === null ? null : item.dueAt))
      const [timeText, setTimeText] = useState(timeInputOf(item === null ? null : item.dueAt))
      const [tags, setTags] = useState(item === null ? [] : [...item.tags])
      const [freq, setFreq] = useState(item === null || item.recurrence === null ? '' : item.recurrence.freq)
      const [interval, setInterval] = useState(item === null || item.recurrence === null ? 1 : item.recurrence.interval)
      const [untilText, setUntilText] = useState(dateInputOf(item === null || item.recurrence === null ? null : item.recurrence.until))
      const [remindText, setRemindText] = useState(
        item === null || item.reminder === null ? '' : String(item.reminder.leadMinutes)
      )
      const [error, setError] = useState(null)
      const [childRows, setChildRows] = useState([])

      function addChildRow() {
        childRowSeq += 1
        setChildRows((rows) => [...rows, { key: `child-row-${childRowSeq}`, title: '' }])
      }

      function updateChildRow(key, value) {
        setChildRows((rows) => rows.map((row) => (row.key === key ? { key: row.key, title: value } : row)))
      }

      function removeChildRow(key) {
        setChildRows((rows) => rows.filter((row) => row.key !== key))
      }

      function buildPatch() {
        const trimmed = title.trim()
        if (trimmed === '') {
          setError('标题不能为空')
          return null
        }
        if (trimmed.length > 200) {
          setError('标题不能超过 200 字')
          return null
        }
        let dueAt = null
        let until = null
        try {
          dueAt = dateText === '' ? null : toIso(`${dateText}T${timeText === '' ? '23:59' : timeText}`, timeText === '')
          until = untilText === '' ? null : toIso(`${untilText}T23:59`, true)
        } catch (error) {
          setError(error.message)
          return null
        }
        const recurrence = freq === ''
          ? null
          : {
            freq,
            interval: Number(interval),
            until
          }
        if (recurrence !== null && recurrence.until !== null && dueAt !== null && Date.parse(recurrence.until) < Date.parse(dueAt)) {
          setError('重复终止时间早于截止时间')
          return null
        }
        if (recurrence !== null && dueAt === null) {
          setError('设置重复需要填写截止日期')
          return null
        }
        const reminder = remindText === ''
          ? null
          : { leadMinutes: Number(remindText), snoozeUntil: null }
        const children = childRows.map((row) => row.title.trim()).filter((childTitle) => childTitle !== '')
        setError(null)
        return { title: trimmed, description, dueAt, tags, recurrence, reminder, children }
      }

      return {
        title, setTitle, description, setDescription, dateText, setDateText, timeText, setTimeText,
        tags, setTags, freq, setFreq, interval, setInterval, untilText, setUntilText,
        remindText, setRemindText, error, setError, buildPatch, settings,
        childRows, addChildRow, updateChildRow, removeChildRow
      }
    }

    function EditorFields(props) {
      const { fields, tagCandidates, disabled, autoFocus } = props
      const titleRef = useRef(null)
      const rowRefs = useRef(new Map())
      const rowCount = useRef(fields.childRows.length)

      useEffect(() => {
        if (autoFocus === true && titleRef.current !== null) titleRef.current.focus()
      }, [autoFocus])

      useEffect(() => {
        const count = fields.childRows.length
        if (count > rowCount.current) {
          const node = rowRefs.current.get(fields.childRows[count - 1].key)
          if (node !== undefined) node.focus()
        }
        rowCount.current = count
      }, [fields.childRows])

      function collectRowRef(row) {
        return (node) => {
          if (node === null) rowRefs.current.delete(row.key)
          else rowRefs.current.set(row.key, node)
        }
      }

      return h('div', { className: 'tc-editor' },
        h('div', { className: 'tc-field' },
          h('span', { className: 'tc-field-name' }, '标题'),
          h('input', {
            className: 'tc-input',
            ref: titleRef,
            value: fields.title,
            maxLength: 200,
            placeholder: '待办标题',
            disabled,
            onChange: (event) => fields.setTitle(event.target.value),
            'aria-label': '标题'
          })
        ),
        h('div', { className: 'tc-field' },
          h('span', { className: 'tc-field-name' }, '计划截止时间'),
          h('div', { className: 'tc-row' },
            h('input', {
              className: 'tc-input',
              type: 'date',
              value: fields.dateText,
              disabled,
              onChange: (event) => fields.setDateText(event.target.value),
              'aria-label': '截止日期'
            }),
            h('input', {
              className: 'tc-input',
              type: 'time',
              value: fields.timeText,
              disabled,
              onChange: (event) => fields.setTimeText(event.target.value),
              'aria-label': '截止时刻'
            })
          )
        ),
        h('div', { className: 'tc-field tc-field-grow' },
          h('span', { className: 'tc-field-name' }, '描述'),
          h('textarea', {
            className: 'tc-textarea',
            value: fields.description,
            rows: 3,
            disabled,
            placeholder: '补充说明',
            onChange: (event) => fields.setDescription(event.target.value),
            'aria-label': '描述'
          })
        ),
        h('div', { className: 'tc-field' },
          h('span', { className: 'tc-field-name' }, '子待办'),
          fields.childRows.map((row, index) => h('div', { key: row.key, className: 'tc-child-row' },
            h('input', {
              className: 'tc-input',
              ref: collectRowRef(row),
              value: row.title,
              maxLength: 200,
              placeholder: '子待办标题',
              disabled,
              onChange: (event) => fields.updateChildRow(row.key, event.target.value),
              'aria-label': `子待办标题 ${index + 1}`
            }),
            iconButton({
              icon: 'trash',
              size: 14,
              title: '移除这一行',
              label: `移除子待办 ${index + 1}`,
              disabled,
              onClick: () => fields.removeChildRow(row.key)
            })
          )),
          h('button', {
            className: 'tc-link',
            onClick: fields.addChildRow,
            disabled
          }, fields.childRows.length === 0 ? '添加一行' : '再添加一行')
        ),
        h('div', { className: 'tc-field' },
          h('span', { className: 'tc-field-name' }, '重复'),
          h('div', { className: 'tc-row' },
            h('select', {
              className: 'tc-select',
              value: fields.freq,
              disabled,
              onChange: (event) => fields.setFreq(event.target.value),
              'aria-label': '重复频率'
            }, FREQ_CHOICES.map((choice) => h('option', { key: choice.value, value: choice.value }, choice.name))),
            fields.freq === ''
              ? null
              : h('input', {
                className: 'tc-input',
                type: 'number',
                min: 1,
                max: 12,
                value: fields.interval,
                disabled,
                onChange: (event) => fields.setInterval(event.target.value),
                'aria-label': '重复间隔'
              }),
            fields.freq === ''
              ? null
              : h('span', { className: 'tc-hint' }, '个周期'),
            fields.freq === ''
              ? null
              : h('input', {
                className: 'tc-input',
                type: 'date',
                value: fields.untilText,
                disabled,
                onChange: (event) => fields.setUntilText(event.target.value),
                'aria-label': '重复终止日期'
              }),
            fields.freq === ''
              ? null
              : h('span', { className: 'tc-hint' }, '为空表示一直重复')
          ),
          fields.freq === ''
            ? null
            : h('div', { className: 'tc-hint' }, previewOf(fields.freq, fields.interval, fields.untilText))
        ),
        h('div', { className: 'tc-field' },
          h('span', { className: 'tc-field-name' }, '提醒'),
          h('select', {
            className: 'tc-select',
            value: fields.remindText,
            disabled,
            onChange: (event) => fields.setRemindText(event.target.value),
            'aria-label': '提醒提前量'
          }, REMINDER_CHOICES.map((choice) => h('option', { key: choice.value, value: choice.value }, choice.name)))
        ),
        fields.error === null
          ? null
          : h('div', { className: 'tc-parse-error' }, fields.error)
      )
    }

    function previewOf(freq, interval, untilText) {
      const unit = freq === 'daily' ? '天' : freq === 'weekly' ? '周' : '月'
      const count = Number(interval) >= 1 ? Number(interval) : 1
      const head = `每 ${count} ${unit}重复`
      return untilText === '' ? head : `${head}，到 ${untilText} 结束`
    }

    let dialogSeq = 0

    function useDialogTitleId() {
      const [id] = useState(() => {
        dialogSeq += 1
        return `tc-dialog-title-${dialogSeq}`
      })
      return id
    }

    function TodoEditorDrawer(props) {
      const { mode, item, quadrantId, trigger, handlers, onClose, onSave } = props
      const tagCandidates = handlers.tagCandidates
      const titleId = useDialogTitleId()
      const fields = useEditorFields(mode === 'edit' ? item : null)
      const [quadrant, setQuadrant] = useState(quadrantId)
      const [busy, setBusy] = useState(false)
      const panelRef = useRef(null)
      const creating = mode === 'create'
      const children = creating || item === null ? [] : (handlers.childrenByParent.get(item.id) ?? [])

      useEffect(() => {
        const overflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const panel = panelRef.current
        if (panel !== null) {
          const field = panel.querySelector('input,textarea,select')
          if (field instanceof HTMLElement) field.focus({ preventScroll: true })
        }
        return () => {
          document.body.style.overflow = overflow
          if (trigger instanceof HTMLElement && trigger.isConnected === true) {
            trigger.focus({ preventScroll: true })
          }
        }
      }, [])

      async function submit() {
        const patch = fields.buildPatch()
        if (patch === null) return
        setBusy(true)
        await onSave(patch, quadrant)
        setBusy(false)
      }

      // Tab 只在抽屉内循环，焦点不跑到背后页面上
      function onKeyDown(event) {
        if (event.key === 'Escape') {
          event.stopPropagation()
          if (busy !== true) onClose()
          return
        }
        if (event.key !== 'Tab') return
        const panel = panelRef.current
        if (panel === null) return
        const focusable = [...panel.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]')]
        if (focusable.length === 0) return
        const active = document.activeElement
        const inside = active !== null && panel.contains(active)
        if (inside === false) {
          event.preventDefault()
          focusable[0].focus()
          return
        }
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey === true && active === first) {
          event.preventDefault()
          last.focus()
        } else if (event.shiftKey !== true && active === last) {
          event.preventDefault()
          first.focus()
        }
      }

      return h('div', { className: 'tc-modal-mask tc-drawer-mask', role: 'presentation', onMouseDown: (event) => {
        if (event.target === event.currentTarget && busy !== true) onClose()
      } },
        h('aside', {
          className: 'tc-modal tc-drawer',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': titleId,
          'data-tc-drawer': mode,
          ref: panelRef,
          onKeyDown
        },
          h('div', { className: 'tc-drawer-head' },
            h('h2', { className: 'tc-modal-title tc-drawer-title', id: titleId }, creating ? '添加待办' : '编辑待办'),
            h('button', {
              className: 'tc-icon-button',
              onClick: onClose,
              disabled: busy,
              title: '关闭',
              'aria-label': '关闭面板'
            }, iconSvg('close', 16))
          ),
          h('div', { className: 'tc-drawer-body' },
            h('div', { className: 'tc-field' },
              h('span', { className: 'tc-field-name' }, '象限'),
              h('div', {
                className: 'tc-quadrant-grid',
                role: 'radiogroup',
                'aria-label': '象限'
              }, QUADRANTS.map((entry) => h('button', {
                key: entry.id,
                type: 'button',
                className: 'tc-quadrant-option',
                'data-tc-quadrant-option': entry.id,
                role: 'radio',
                'aria-checked': quadrant === entry.id,
                'aria-label': entry.name,
                disabled: busy,
                onClick: () => setQuadrant(entry.id)
              },
                h('span', { className: 'tc-quadrant-dot' }),
                h('span', { className: 'tc-quadrant-name' }, entry.name)
              )))
            ),
            creating || children.length === 0
              ? null
              : h('div', { className: 'tc-field' },
                h('span', { className: 'tc-field-name' }, '已有子待办'),
                children.map((child) => h('div', { key: child.id, className: 'tc-child' },
                  h('button', {
                    className: 'tc-check',
                    'aria-pressed': child.status === 'done',
                    'aria-label': `完成「${child.title}」`,
                    disabled: busy,
                    onClick: () => handlers.completeOne(child)
                  }, child.status === 'done' ? '✓' : ''),
                  h('span', { className: 'tc-child-title' }, child.title)
                ))
              ),
            h(EditorFields, { fields, tagCandidates, disabled: busy, autoFocus: true })
          ),
          h('div', { className: 'tc-modal-actions tc-drawer-foot' },
            h('button', { className: 'tc-button tc-button-primary', onClick: submit, disabled: busy }, busy ? '正在保存…' : (creating ? '添加' : '保存')),
            h('button', { className: 'tc-button', onClick: onClose, disabled: busy }, '取消')
          )
        )
      )
    }

    // ---------- 已完成清单 ----------

    function doneBoundsOf(range, from, to, now) {
      if (range === 'all') return { from: null, to: null }
      if (range === 'custom') {
        return {
          from: from === '' ? null : dateInputBoundary(from, false),
          to: to === '' ? null : dateInputBoundary(to, true)
        }
      }
      const start = range === 'today' ? startOfToday(now) : range === 'week' ? startOfWeek(now) : startOfMonth(now)
      return { from: start, to: now }
    }

    function CompletedList(props) {
      const { items, handlers, range, from, to } = props
      const readOnly = handlers.readOnly === true
      const bounds = doneBoundsOf(range, from, to, handlers.now)
      const rows = items
        .filter((item) => {
          const time = completedTime(item)
          if (time === null) return false
          if (bounds.from !== null && time < bounds.from) return false
          if (bounds.to !== null && time > bounds.to) return false
          return true
        })
        .sort((left, right) => completedTime(right) - completedTime(left))
      const childrenByParent = handlers.childrenByParent

      function reopen(item) {
        handlers.runWrite(() => call('/reopen', { ids: [item.id] }))
      }

      function remove(item) {
        handlers.setConfirmState({
          text: `永久删除「${item.title}」？此操作不可恢复。`,
          confirmLabel: '永久删除',
          run: () => handlers.runWrite(() => call('/remove', { ids: [item.id] }))
        })
      }

      return h('div', { className: 'tc-list-view' },
        h('div', { className: 'tc-list-head' },
          h('span', null, `共 ${rows.length} 条`)
        ),
        rows.length === 0
          ? h('div', { className: 'tc-section-empty' }, '所选范围内没有已完成的待办')
          : rows.map((item) => {
            const childCount = (childrenByParent.get(item.id) ?? []).length
            return h('div', { key: item.id, className: 'tc-list-row', 'data-tc-done-id': item.id },
              h('div', { className: 'tc-list-title' },
                h('span', { className: 'tc-card-title tc-card-title-done tc-ellipsis' }, item.title),
                childCount === 0
                  ? null
                  : h('span', { className: 'tc-card-meta-item' }, `${childCount} 个子待办`)
              ),
              h('span', { className: 'tc-card-meta-item' }, `截止 ${formatMoment(item.dueAt)}`),
              h('span', { className: 'tc-card-meta-item' }, `完成 ${formatMoment(item.completedAt)}`),
              h('div', { className: 'tc-list-actions' },
                h('button', {
                  className: 'tc-button tc-button-small',
                  onClick: () => reopen(item),
                  disabled: readOnly,
                  title: readOnly ? handlers.readOnlyReason : '撤销完成',
                  'aria-label': `撤销完成「${item.title}」`
                }, '撤销'),
                h('button', {
                  className: 'tc-button tc-button-small',
                  onClick: () => remove(item),
                  disabled: readOnly,
                  title: readOnly ? handlers.readOnlyReason : '永久删除',
                  'aria-label': `删除「${item.title}」`
                }, '删除')
              )
            )
          })
      )
    }

    // ---------- 对话框 ----------

    function DialogFrame(props) {
      const { title, text, children, actions, closed, width } = props
      const titleId = useDialogTitleId()
      return h('div', { className: 'tc-modal-mask', role: 'presentation', onMouseDown: (event) => {
        if (event.target === event.currentTarget) closed()
      } },
        h('div', {
          className: width === 'wide' ? 'tc-modal tc-modal-wide' : 'tc-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': titleId,
          onKeyDown: (event) => {
            if (event.key === 'Escape') closed()
          }
        },
          h('div', { className: 'tc-modal-title', id: titleId }, title),
          text === undefined || text === null
            ? null
            : h('div', { className: 'tc-modal-text' }, text),
          children,
          h('div', { className: 'tc-modal-actions' }, actions)
        )
      )
    }

    function ConfirmDialog(props) {
      const { title, text, confirmLabel, error, busy, onCancel, onConfirm } = props
      const heading = title === undefined ? '确认操作' : title
      return h(DialogFrame, {
        title: heading,
        text,
        closed: () => {
          if (busy !== true) onCancel()
        },
        actions: [
          h('button', { key: 'ok', className: 'tc-button tc-button-primary', onClick: onConfirm, disabled: busy === true }, confirmLabel),
          h('button', { key: 'cancel', className: 'tc-button', onClick: onCancel, disabled: busy === true }, '取消')
        ]
      },
        error === undefined || error === null
          ? null
          : h('div', { className: 'tc-modal-error' }, error)
      )
    }

    function PromptDialog(props) {
      const { title, label, value, error, maxLength, placeholder, confirmLabel, onChange, onCancel, onConfirm } = props
      const inputRef = useRef(null)

      useEffect(() => {
        if (inputRef.current !== null) inputRef.current.focus()
      }, [])

      return h(DialogFrame, {
        title,
        closed: onCancel,
        actions: [
          h('button', { key: 'ok', className: 'tc-button tc-button-primary', onClick: onConfirm }, confirmLabel),
          h('button', { key: 'cancel', className: 'tc-button', onClick: onCancel }, '取消')
        ]
      },
        h('div', { className: 'tc-field' },
          h('span', { className: 'tc-field-name' }, label),
          h('input', {
            className: 'tc-input',
            ref: inputRef,
            value,
            maxLength,
            placeholder,
            onChange: (event) => onChange(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') onConfirm()
            },
            'aria-label': label
          })
        ),
        error === undefined || error === null
          ? null
          : h('div', { className: 'tc-modal-error' }, error)
      )
    }

    function ImportDialog(props) {
      const { state, currentCount, onCancel, onConfirm } = props
      const payload = state.payload
      const rows = payload === null
        ? []
        : [
          { name: '文件名', value: state.fileName },
          { name: '文件版本', value: String(payload.version) },
          { name: '条目数', value: String(Array.isArray(payload.todos) ? payload.todos.length : 0) },
          { name: '筛选预设数', value: String(Array.isArray(payload.filters) ? payload.filters.length : 0) }
        ]
      const busy = state.busy === true

      return h(DialogFrame, {
        title: '导入数据',
        closed: () => {
          if (busy !== true) onCancel()
        },
        actions: [
          h('button', {
            key: 'ok',
            className: 'tc-button tc-button-primary',
            onClick: onConfirm,
            disabled: busy || payload === null
          }, busy ? '正在导入…' : '整份替换'),
          h('button', { key: 'cancel', className: 'tc-button', onClick: onCancel, disabled: busy }, '取消')
        ]
      },
        rows.length === 0
          ? null
          : h('div', { className: 'tc-modal-list' },
            rows.map((row) => h('div', { key: row.name, className: 'tc-kv-row' },
              h('span', { className: 'tc-kv-name' }, row.name),
              h('span', { className: 'tc-kv-value' }, row.value)
            ))
          ),
        h('div', { className: 'tc-modal-note' }, `当前有 ${currentCount} 条未完成的顶层待办，导入会把整份数据替换为文件内容，导入前的数据会备份到数据目录。`),
        state.error === undefined || state.error === null
          ? null
          : h('div', { className: 'tc-modal-error' }, state.error)
      )
    }

    function DuplicateRecurrenceDialog(props) {
      const { state, todos, onSearch, onSelect, onCancel, onConfirm } = props
      const source = todos.find((item) => item.id === state.sourceId)
      const keyword = state.search.trim()
      const target = todos.find((item) => item.id === state.targetId)
      const candidates = todos
        .filter((item) => item.parentId === null && item.status === 'open' && item.id !== state.sourceId)
        .filter((item) => keyword === '' || item.title.includes(keyword))
        .slice(0, 20)

      return h(DialogFrame, {
        title: '复制重复设置',
        width: 'wide',
        text: `把「${source === undefined ? '' : source.title}」的重复设置复制到另一条待办。`,
        closed: onCancel,
        actions: [
          h('button', {
            key: 'ok',
            className: 'tc-button tc-button-primary',
            onClick: onConfirm,
            disabled: state.targetId === null
          }, '复制'),
          h('button', { key: 'cancel', className: 'tc-button', onClick: onCancel }, '取消')
        ]
      },
        source === undefined || source.recurrence === null
          ? null
          : h('div', { className: 'tc-modal-note' }, `当前规则：${recurrenceText(source.recurrence)}`),
        h('div', { className: 'tc-field' },
          h('span', { className: 'tc-field-name' }, '搜索目标待办'),
          h('input', {
            className: 'tc-input',
            value: state.search,
            placeholder: '输入标题片段',
            onChange: (event) => onSearch(event.target.value),
            'aria-label': '搜索目标待办'
          })
        ),
        h('div', { className: 'tc-modal-list' },
          candidates.length === 0
            ? h('div', { className: 'tc-section-empty' }, '没有可选的目标待办')
            : candidates.map((item) => h('button', {
              key: item.id,
              className: item.id === state.targetId ? 'tc-modal-list-row tc-modal-list-row-on' : 'tc-modal-list-row',
              onClick: () => onSelect(item.id),
              'aria-pressed': item.id === state.targetId
            },
              h('span', { className: 'tc-modal-list-title' }, item.title),
              h('span', { className: 'tc-modal-list-when' }, item.dueAt === null ? '未安排' : formatMoment(item.dueAt))
            ))
        ),
        target === undefined
          ? null
          : h('div', { className: 'tc-modal-note' }, `已选择「${target.title}」`),
        state.error === undefined || state.error === null
          ? null
          : h('div', { className: 'tc-modal-error' }, state.error)
      )
    }

    // ---------- 输入框上方待确认提示条 ----------

    function TodoCenterDock(props) {
      const [pending, setPending] = useState([])
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const sessionId = props.sessionId

      useEffect(() => {
        let stopped = false

        async function load() {
          try {
            const response = await fetch(`${ROUTE}/pending?sessionId=${encodeURIComponent(sessionId)}`)
            const payload = await response.json()
            if (stopped) return
            if (payload.ok !== true) {
              setError(payload.error ?? '待确认事项读取失败')
              return
            }
            setPending(Array.isArray(payload.value.items) ? payload.value.items : [])
            setError(null)
          } catch (loadError) {
            if (!stopped) setError(messageOf(loadError))
          }
        }

        load()
        const timer = setInterval(load, POLL_INTERVAL)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [sessionId])

      async function addAll() {
        setBusy(true)
        try {
          for (const entry of pending) {
            await call('/fromConversation', {
              sessionId,
              entryId: entry.entryId,
              entryType: entry.entryType,
              title: entry.title,
              description: entry.description,
              workspaceId: entry.workspaceId,
              quadrant: entry.quadrant
            })
          }
          setPending([])
          await loadSnapshot()
        } catch (addError) {
          setError(messageOf(addError))
        } finally {
          setBusy(false)
        }
      }

      if (pending.length === 0) {
        return error === null ? null : h('div', { className: 'tc-dock' },
          h('span', { className: 'tc-dock-error' }, error)
        )
      }

      return h('div', { className: 'tc-dock' },
        h(StyleSheet),
        h('span', { className: 'tc-dock-text' }, `本会话有 ${pending.length} 个待确认事项`),
        h('button', {
          className: 'tc-button tc-button-small tc-button-primary',
          onClick: addAll,
          disabled: busy
        }, busy ? '正在加入…' : '加入待办中心'),
        error === null ? null : h('span', { className: 'tc-dock-error' }, error)
      )
    }

    // ---------- 提醒轮询 ----------

    function startReminderPolling(ctx) {
      ctx.effect(() => {
        let lastCount = 0

        async function tick() {
          await loadReminders()
          // 标签页可见且没有进行中的写入时同步一次数据，其他窗口的改动随之出现在面板上
          if (store.loaded && store.pendingWrites === 0 && document.visibilityState === 'visible') {
            await refreshData()
          }
          if (store.reminderCount > lastCount && store.reminders.length > 0) {
            const first = store.reminders[0]
            store.reminderOverlay = { count: store.reminderCount, title: first.title, dueAt: first.dueAt }
            publish()
          }
          lastCount = store.reminderCount
        }

        tick()
        const timer = ctx.timer.interval(tick, POLL_INTERVAL)
        return () => timer()
      }, 'dsh-4quadrant-todo: 提醒轮询')
    }

    // ---------- 插件注册 ----------

    function apply(ctx) {
      runtime.ctx = ctx

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 2,
        label: () => '待办中心'
      }, PanelIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID
      }, TodoCenterPage))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'four-quadrant-todo.reminder',
        order: 80
      }, ReminderOverlay))

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'four-quadrant-todo',
        order: 60,
        inject: (sessionId) => ({ sessionId })
      }, TodoCenterDock))

      startReminderPolling(ctx)
    }

    return {
      inject: ['slots', 'layout', 'timer', 'sessions', 'uiWorkspace', 'workspaces'],
      apply
    }
  }
})
