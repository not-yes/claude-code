import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import chalk from 'chalk'
import {
  addToTotalCostState,
  addToTotalLinesChanged,
  getCostCounter,
  getModelUsage,
  getSdkBetas,
  getSessionId,
  getTokenCounter,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCostUSD,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
  getTotalToolDuration,
  getTotalWebSearchRequests,
  getUsageForModel,
  hasUnknownModelCost,
  resetCostState,
  resetStateForTests,
  setCostStateForRestore,
  setHasUnknownModelCost,
} from './bootstrap/state.js'
import type { ModelUsage } from './entrypoints/agentSdkTypes.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from './services/analytics/index.js'
import { getAdvisorUsage } from './utils/advisor.js'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from './utils/config.js'
import type { SessionCostRecord } from './utils/config.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from './utils/context.js'
import { isFastModeEnabled } from './utils/fastMode.js'
import { formatDuration, formatNumber } from './utils/format.js'
import type { FpsMetrics } from './utils/fpsTracker.js'
import { getCanonicalName } from './utils/model/model.js'
import { calculateUSDCost } from './utils/modelCost.js'
export {
  getTotalCostUSD as getTotalCost,
  getTotalDuration,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  addToTotalLinesChanged,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalInputTokens,
  getTotalOutputTokens,
  getTotalCacheReadInputTokens,
  getTotalCacheCreationInputTokens,
  getTotalWebSearchRequests,
  formatCost,
  hasUnknownModelCost,
  resetStateForTests,
  resetCostState,
  setHasUnknownModelCost,
  getModelUsage,
  getUsageForModel,
}

type StoredCostState = {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}

/**
 * Gets stored cost state from project config.
 * Unconditionally returns the last saved cost data regardless of session ID.
 * Use this to read costs BEFORE overwriting the config with saveCurrentSessionCosts().
 */
export function getStoredSessionCosts(): StoredCostState | undefined {
  const projectConfig = getCurrentProjectConfig()

  // 无条件恢复上一个会话的累计数据（不再检查 sessionId）
  if (projectConfig.lastCost == null && projectConfig.lastAPIDuration == null) {
    return undefined
  }

  // Build model usage with context windows
  let modelUsage: { [modelName: string]: ModelUsage } | undefined
  if (projectConfig.lastModelUsage) {
    modelUsage = Object.fromEntries(
      Object.entries(projectConfig.lastModelUsage).map(([model, usage]) => [
        model,
        {
          ...usage,
          contextWindow: getContextWindowForModel(model, getSdkBetas()),
          maxOutputTokens: getModelMaxOutputTokens(model).default,
        },
      ]),
    )
  }

  return {
    totalCostUSD: projectConfig.lastCost ?? 0,
    totalAPIDuration: projectConfig.lastAPIDuration ?? 0,
    totalAPIDurationWithoutRetries:
      projectConfig.lastAPIDurationWithoutRetries ?? 0,
    totalToolDuration: projectConfig.lastToolDuration ?? 0,
    totalLinesAdded: projectConfig.lastLinesAdded ?? 0,
    totalLinesRemoved: projectConfig.lastLinesRemoved ?? 0,
    lastDuration: projectConfig.lastDuration,
    modelUsage,
  }
}

/**
 * Restores cost state from project config when resuming a session.
 * Unconditionally restores the last saved cost data regardless of session ID.
 * @returns true if cost state was restored, false otherwise
 */
export function restoreCostStateForSession(): boolean {
  const data = getStoredSessionCosts()
  if (!data) {
    return false
  }
  setCostStateForRestore(data)
  return true
}

/** 返回 ISO 周格式字符串，如 "2026-W15" */
function getISOWeekString(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

/**
 * Saves the current session's costs to project config.
 * Call this before switching sessions to avoid losing accumulated costs.
 */
export function saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void {
  const now = Date.now()
  const dateObj = new Date(now)
  const dateStr = dateObj.toISOString().split('T')[0]
  const monthStr = dateObj.toISOString().substring(0, 7)
  const weekStr = getISOWeekString(dateObj)

  const record: SessionCostRecord = {
    sessionId: getSessionId(),
    timestamp: now,
    date: dateStr,
    week: weekStr,
    month: monthStr,
    costUSD: getTotalCostUSD(),
    inputTokens: getTotalInputTokens(),
    outputTokens: getTotalOutputTokens(),
    cacheReadTokens: getTotalCacheReadInputTokens(),
    cacheCreationTokens: getTotalCacheCreationInputTokens(),
    linesAdded: getTotalLinesAdded(),
    linesRemoved: getTotalLinesRemoved(),
    durationMs: getTotalDuration(),
    modelUsage: Object.fromEntries(
      Object.entries(getModelUsage()).map(([model, usage]) => [
        model,
        {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          costUSD: usage.costUSD ?? 0,
        },
      ])
    ),
  }

  saveCurrentProjectConfig(current => {
    // 保留最近 90 天的历史
    const cutoff = now - 90 * 24 * 3600 * 1000
    const history = (current.costHistory ?? []).filter(r => r.timestamp > cutoff)

    return {
      ...current,
      lastCost: getTotalCostUSD(),
      lastAPIDuration: getTotalAPIDuration(),
      lastAPIDurationWithoutRetries: getTotalAPIDurationWithoutRetries(),
      lastToolDuration: getTotalToolDuration(),
      lastDuration: getTotalDuration(),
      lastLinesAdded: getTotalLinesAdded(),
      lastLinesRemoved: getTotalLinesRemoved(),
      lastTotalInputTokens: getTotalInputTokens(),
      lastTotalOutputTokens: getTotalOutputTokens(),
      lastTotalCacheCreationInputTokens: getTotalCacheCreationInputTokens(),
      lastTotalCacheReadInputTokens: getTotalCacheReadInputTokens(),
      lastTotalWebSearchRequests: getTotalWebSearchRequests(),
      lastFpsAverage: fpsMetrics?.averageFps,
      lastFpsLow1Pct: fpsMetrics?.low1PctFps,
      lastModelUsage: Object.fromEntries(
        Object.entries(getModelUsage()).map(([model, usage]) => [
          model,
          {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            webSearchRequests: usage.webSearchRequests,
            costUSD: usage.costUSD,
          },
        ]),
      ),
      lastSessionId: getSessionId(),
      costHistory: [...history, record],
    }
  })
}

function formatCost(cost: number, maxDecimalPlaces: number = 4): string {
  return `$${cost > 0.5 ? round(cost, 100).toFixed(2) : cost.toFixed(maxDecimalPlaces)}`
}

function formatModelUsage(): string {
  const modelUsageMap = getModelUsage()
  if (Object.keys(modelUsageMap).length === 0) {
    return 'Usage:                 0 input, 0 output, 0 cache read, 0 cache write'
  }

  // Accumulate usage by short name
  const usageByShortName: { [shortName: string]: ModelUsage } = {}
  for (const [model, usage] of Object.entries(modelUsageMap)) {
    const shortName = getCanonicalName(model)
    if (!usageByShortName[shortName]) {
      usageByShortName[shortName] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
      }
    }
    const accumulated = usageByShortName[shortName]
    accumulated.inputTokens += usage.inputTokens
    accumulated.outputTokens += usage.outputTokens
    accumulated.cacheReadInputTokens += usage.cacheReadInputTokens
    accumulated.cacheCreationInputTokens += usage.cacheCreationInputTokens
    accumulated.webSearchRequests += usage.webSearchRequests
    accumulated.costUSD += usage.costUSD
  }

  let result = 'Usage by model:'
  for (const [shortName, usage] of Object.entries(usageByShortName)) {
    const usageString =
      `  ${formatNumber(usage.inputTokens)} input, ` +
      `${formatNumber(usage.outputTokens)} output, ` +
      `${formatNumber(usage.cacheReadInputTokens)} cache read, ` +
      `${formatNumber(usage.cacheCreationInputTokens)} cache write` +
      (usage.webSearchRequests > 0
        ? `, ${formatNumber(usage.webSearchRequests)} web search`
        : '') +
      ` (${formatCost(usage.costUSD)})`
    result += `\n` + `${shortName}:`.padStart(21) + usageString
  }
  return result
}

export function formatTotalCost(): string {
  const costDisplay =
    formatCost(getTotalCostUSD()) +
    (hasUnknownModelCost()
      ? ' (costs may be inaccurate due to usage of unknown models)'
      : '')

  const modelUsageDisplay = formatModelUsage()

  return chalk.dim(
    `Total cost:            ${costDisplay}\n` +
      `Total duration (API):  ${formatDuration(getTotalAPIDuration())}
Total duration (wall): ${formatDuration(getTotalDuration())}
Total code changes:    ${getTotalLinesAdded()} ${getTotalLinesAdded() === 1 ? 'line' : 'lines'} added, ${getTotalLinesRemoved()} ${getTotalLinesRemoved() === 1 ? 'line' : 'lines'} removed
${modelUsageDisplay}`,
  )
}

function round(number: number, precision: number): number {
  return Math.round(number * precision) / precision
}

function addToTotalModelUsage(
  cost: number,
  usage: Usage,
  model: string,
): ModelUsage {
  const modelUsage = getUsageForModel(model) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
  }

  modelUsage.inputTokens += usage.input_tokens
  modelUsage.outputTokens += usage.output_tokens
  modelUsage.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
  modelUsage.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0
  modelUsage.webSearchRequests +=
    usage.server_tool_use?.web_search_requests ?? 0
  modelUsage.costUSD += cost
  modelUsage.contextWindow = getContextWindowForModel(model, getSdkBetas())
  modelUsage.maxOutputTokens = getModelMaxOutputTokens(model).default
  return modelUsage
}

export function addToTotalSessionCost(
  cost: number,
  usage: Usage,
  model: string,
): number {
  const modelUsage = addToTotalModelUsage(cost, usage, model)
  addToTotalCostState(cost, modelUsage, model)

  const attrs =
    isFastModeEnabled() && usage.speed === 'fast'
      ? { model, speed: 'fast' }
      : { model }

  getCostCounter()?.add(cost, attrs)
  getTokenCounter()?.add(usage.input_tokens, { ...attrs, type: 'input' })
  getTokenCounter()?.add(usage.output_tokens, { ...attrs, type: 'output' })
  getTokenCounter()?.add(usage.cache_read_input_tokens ?? 0, {
    ...attrs,
    type: 'cacheRead',
  })
  getTokenCounter()?.add(usage.cache_creation_input_tokens ?? 0, {
    ...attrs,
    type: 'cacheCreation',
  })

  let totalCost = cost
  for (const advisorUsage of getAdvisorUsage(usage)) {
    const advisorCost = calculateUSDCost(advisorUsage.model, advisorUsage)
    logEvent('tengu_advisor_tool_token_usage', {
      advisor_model:
        advisorUsage.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      input_tokens: advisorUsage.input_tokens,
      output_tokens: advisorUsage.output_tokens,
      cache_read_input_tokens: advisorUsage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens:
        advisorUsage.cache_creation_input_tokens ?? 0,
      cost_usd_micros: Math.round(advisorCost * 1_000_000),
    })
    totalCost += addToTotalSessionCost(
      advisorCost,
      advisorUsage,
      advisorUsage.model,
    )
  }
  return totalCost
}

/** 获取所有历史成本记录（最近 90 天） */
export function getCostHistory(): SessionCostRecord[] {
  const config = getCurrentProjectConfig()
  return config.costHistory ?? []
}

/** 按月聚合成本统计 */
export function aggregateCostByMonth(): Record<string, {
  costUSD: number
  inputTokens: number
  outputTokens: number
  sessions: number
}> {
  const history = getCostHistory()
  const result: Record<string, { costUSD: number; inputTokens: number; outputTokens: number; sessions: number }> = {}
  for (const record of history) {
    if (!result[record.month]) {
      result[record.month] = { costUSD: 0, inputTokens: 0, outputTokens: 0, sessions: 0 }
    }
    result[record.month].costUSD += record.costUSD
    result[record.month].inputTokens += record.inputTokens
    result[record.month].outputTokens += record.outputTokens
    result[record.month].sessions += 1
  }
  return result
}

/** 按周聚合成本统计 */
export function aggregateCostByWeek(): Record<string, {
  costUSD: number
  inputTokens: number
  outputTokens: number
  sessions: number
}> {
  const history = getCostHistory()
  const result: Record<string, { costUSD: number; inputTokens: number; outputTokens: number; sessions: number }> = {}
  for (const record of history) {
    if (!result[record.week]) {
      result[record.week] = { costUSD: 0, inputTokens: 0, outputTokens: 0, sessions: 0 }
    }
    result[record.week].costUSD += record.costUSD
    result[record.week].inputTokens += record.inputTokens
    result[record.week].outputTokens += record.outputTokens
    result[record.week].sessions += 1
  }
  return result
}
