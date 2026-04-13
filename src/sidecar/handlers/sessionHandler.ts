/**
 * sidecar/handlers/sessionHandler.ts
 *
 * 会话扩展 API handler 注册模块。
 *
 * 注册的 RPC 方法：
 *   - getSessions         → 获取会话列表（持久化层）
 *   - getSessionMessages  → 获取指定会话的消息历史
 *   - deleteSession       → 删除/清空指定会话
 *   - getStats            → 获取服务器运行统计信息
 *   - getStatus           → 获取当前服务器状态
 *   - getHealth           → 健康检查（详细版）
 */

import { z } from 'zod'
import {
  getTotalCost,
  getTotalInputTokens,
  getTotalOutputTokens,
  getTotalCacheReadInputTokens,
  getTotalCacheCreationInputTokens,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getModelUsage,
  saveCurrentSessionCosts,
  getCostHistory,
  aggregateCostByMonth,
  aggregateCostByWeek,
} from '../../cost-tracker.js'
import { getTotalToolDuration } from '../../bootstrap/state.js'
import type { JsonRpcServer } from '../jsonRpcServer'
import { listSessionsImpl } from '../../utils/listSessionsImpl.js'
import { extractLastJsonStringField, readSessionLite, resolveSessionFilePath } from '../../utils/sessionStoragePortable.js'

// ─── 参数 Schema ───────────────────────────────────────────────────────────────

const GetSessionsParamsSchema = z.object({
  agent_id: z.string().optional(),
  cwd: z.string().optional(),  // 工作目录过滤
  limit: z.number().int().positive().optional(),
  include_system: z.boolean().optional(),
})

const GetSessionMessagesParamsSchema = z.object({
  sessionId: z.string().min(1, '会话 ID 不能为空'),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
})

const DeleteSessionParamsSchema = z.object({
  sessionId: z.string().min(1, '会话 ID 不能为空'),
})

// ─── 返回类型定义 ──────────────────────────────────────────────────────────────

/** 前端可用的消息内容块格式 */
type MessageContentBlock =
  | { type: 'thinking'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolId: string; toolName: string; result: unknown; isError?: boolean }
  | { type: 'system'; level: 'info' | 'warning' | 'error'; content: string }

interface SessionMessage {
  id?: string
  role: 'user' | 'assistant'
  content: string
  contentBlocks?: MessageContentBlock[]
  created_at?: string
  [key: string]: unknown
}

interface SessionItem {
  id: string
  title?: string
  task?: string
  agent_id?: string
  created_at?: string
  updated_at?: string
  cwd?: string
  tag?: string
  gitBranch?: string
  [key: string]: unknown
}

interface DeleteSessionResult {
  deleted: boolean
}

interface ModelUsageEntry {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUSD: number
}

interface StatsResult {
  // LLM 成本
  totalCostUsd: number
  modelUsage: Record<string, ModelUsageEntry>
  // Token 统计
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  // 性能耗时
  apiDurationMs: number
  apiDurationWithoutRetriesMs: number
  toolDurationMs: number
  // 代码变更
  linesAdded: number
  linesRemoved: number
  // 会话
  totalSessions: number
  activeSession: boolean
  uptime: number
  // 系统
  memoryUsage: NodeJS.MemoryUsage
}

interface StatusResult {
  status: 'ready' | 'busy' | 'error'
  currentExecuteId?: string
  sessionId?: string
}

interface HealthResult {
  healthy: true
  timestamp: number
  uptime: number
  version: string
}

// ─── 注册函数 ──────────────────────────────────────────────────────────────────

/**
 * 注册会话扩展 API 方法到 JsonRpcServer。
 *
 * @param server JsonRpcServer 实例
 */
export function registerSessionHandlers(server: JsonRpcServer): void {
  const agentCore = server.getAgentCore()

  // ─── getSessions ──────────────────────────────────────────────────────────

  server.registerMethod(
    'getSessions',
    async (params: unknown): Promise<SessionItem[]> => {
      const parsed = GetSessionsParamsSchema.parse(params)
      const limit = parsed.limit ?? 100
      const requestedAgentId = parsed.agent_id // 前端请求的 agent_id
      const requestedCwd = parsed.cwd  // 前端请求的工作目录

      const allSessions: SessionItem[] = []
      const seenIds = new Set<string>()

      // 1. 读取 CLI projects 目录的会话
      try {
        // 优先使用前端传递的 cwd，否则使用 agentCore 的 cwd
        const cwd = requestedCwd || agentCore.getState().cwd
        console.error(`[getSessions] DEBUG: cwd=${cwd}, limit=${limit}, requestedAgentId=${requestedAgentId}`)

        const cliSessions = await listSessionsImpl({ dir: cwd, limit: limit * 2 })
        console.error(`[getSessions] DEBUG: cliSessions.length=${cliSessions.length}`)

        for (const s of cliSessions) {
          if (seenIds.has(s.sessionId)) continue

          // 尝试从 JSONL 头部提取 agentName
          let agentName: string | undefined
          try {
            const resolved = await resolveSessionFilePath(s.sessionId, cwd)
            if (resolved) {
              const lite = await readSessionLite(resolved.filePath)
              if (lite?.head) {
                agentName = extractLastJsonStringField(lite.head, 'agentName')
              }
            }
          } catch {
            // 忽略提取失败
          }

          const sessionAgentId = agentName || 'main'

          // 如果请求了特定 agent_id，只返回匹配的会话
          if (requestedAgentId && sessionAgentId !== requestedAgentId) {
            continue
          }

          seenIds.add(s.sessionId)
          allSessions.push({
            id: s.sessionId,
            title: s.customTitle || s.summary,
            task: s.firstPrompt,
            agent_id: sessionAgentId,
            created_at: s.createdAt ? new Date(s.createdAt).toISOString() : undefined,
            updated_at: new Date(s.lastModified).toISOString(),
            cwd: s.cwd,
            tag: s.tag,
            gitBranch: s.gitBranch,
          })
        }
      } catch (err) {
        console.error(`[getSessions] ERROR: CLI sessions read failed:`, err)
        // CLI 会话读取失败不影响 sidecar 会话
      }

      // 2. 读取 sidecar 自身会话
      try {
        const sidecarSessions = await agentCore.listSessions()
        console.error(`[getSessions] DEBUG: sidecarSessions.length=${sidecarSessions.length}`)

        for (const s of sidecarSessions) {
          if (seenIds.has(s.id)) continue

          // 当前 sidecar 进程对应的 agent 身份（由 Rust 启动时通过 AGENT_ID 环境变量注入）
          const sessionAgentId = process.env.AGENT_ID ?? 'main'

          // 如果请求了特定 agent_id，只返回匹配的会话
          if (requestedAgentId && sessionAgentId !== requestedAgentId) {
            continue
          }

          seenIds.add(s.id)
          allSessions.push({
            id: s.id,
            title: (s.metadata?.['name'] as string | undefined) || `Session ${s.id.slice(0, 8)}`,
            task: undefined,
            agent_id: sessionAgentId,
            created_at: s.createdAt,
            updated_at: s.updatedAt,
            cwd: agentCore.getState().cwd || undefined,
          })
        }
      } catch (err) {
        console.error(`[getSessions] ERROR: sidecar sessions read failed:`, err)
        // sidecar 会话读取失败也不影响已获取的 CLI 会话
      }

      console.error(`[getSessions] DEBUG: allSessions.length=${allSessions.length}`)

      // 3. 按更新时间降序排序并截断
      allSessions.sort((a, b) => {
        const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0
        const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0
        return tb - ta
      })

      return allSessions.slice(0, limit)
    },
  )

  // ─── getSessionMessages ────────────────────────────────────────────────────

  server.registerMethod(
    'getSessionMessages',
    async (params: unknown): Promise<SessionMessage[]> => {
      const { sessionId, offset = 0, limit } = GetSessionMessagesParamsSchema.parse(params)

      try {
        const session = await agentCore.getSession(sessionId)
        if (!session) {
          return []
        }
        const msgs: SessionMessage[] = (session.messages ?? []).map((m: unknown) => {
          const msg = m as Record<string, unknown>

          // 新格式（SDK transcript 包装）: { type, message: { role, content: [...], uuid }, session_id, ... }
          if (msg['type'] && msg['message']) {
            const inner = msg['message'] as Record<string, unknown>
            const role = (inner['role'] as 'user' | 'assistant') ?? 'user'

            let text = ''
            const content = inner['content']
            let contentBlocks: MessageContentBlock[] | undefined

            if (Array.isArray(content)) {
              // content 是 ContentBlock 数组，提取所有 text 块作为纯文本
              text = content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text ?? '')
                .join('')

              // 构建 toolUseMap，用于 tool_result 查找 toolName
              const toolUseMap: Record<string, string> = {}
              for (const block of content) {
                const b = block as Record<string, unknown>
                if (b['type'] === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string') {
                  toolUseMap[b['id'] as string] = b['name'] as string
                }
              }

              // 转换每个 content block 为前端格式
              contentBlocks = content.reduce<MessageContentBlock[]>((acc, block) => {
                const b = block as Record<string, unknown>
                const bType = b['type'] as string

                if (bType === 'thinking') {
                  acc.push({ type: 'thinking', content: (b['thinking'] as string) ?? '' })
                } else if (bType === 'text') {
                  acc.push({ type: 'text', content: (b['text'] as string) ?? '' })
                } else if (bType === 'tool_use') {
                  acc.push({
                    type: 'tool_use',
                    id: (b['id'] as string) ?? '',
                    name: (b['name'] as string) ?? '',
                    input: (b['input'] as Record<string, unknown>) ?? {},
                  })
                } else if (bType === 'tool_result') {
                  const toolId = (b['tool_use_id'] as string) ?? ''
                  acc.push({
                    type: 'tool_result',
                    toolId,
                    toolName: toolUseMap[toolId] ?? '',
                    result: b['content'] ?? b['output'] ?? null,
                    isError: (b['is_error'] as boolean | undefined) ?? false,
                  })
                }
                // 其余类型（如 image 等）暂忽略
                return acc
              }, [])
            } else if (typeof content === 'string') {
              text = content
            } else {
              text = JSON.stringify(content ?? '')
            }

            return {
              id: (inner['uuid'] as string) ?? (msg['id'] as string | undefined),
              role,
              content: text,
              contentBlocks,
              created_at: (msg['created_at'] as string | undefined),
            }
          }

          // 旧格式回退（role/content 顶层字段）
          return {
            id: msg['id'] as string | undefined,
            role: (msg['role'] as 'user' | 'assistant') ?? 'user',
            content:
              typeof msg['content'] === 'string'
                ? (msg['content'] as string)
                : String(msg['content'] ?? ''),
            created_at: msg['created_at'] as string | undefined,
          }
        })
        // 支持分页
        const sliced = limit !== undefined
          ? msgs.slice(offset, offset + limit)
          : msgs.slice(offset)
        return sliced
      } catch {
        return []
      }
    },
  )

  // ─── deleteSession ─────────────────────────────────────────────────────────

  server.registerMethod(
    'deleteSession',
    async (params: unknown): Promise<DeleteSessionResult> => {
      const { sessionId } = DeleteSessionParamsSchema.parse(params)

      try {
        const deleted = await agentCore.deleteSession(sessionId)
        return { deleted }
      } catch {
        return { deleted: false }
      }
    },
  )

  // ─── getStats ──────────────────────────────────────────────────────────────

  server.registerMethod(
    'getStats',
    async (_params: unknown): Promise<StatsResult> => {
      const sessions = await agentCore.listSessions()
      const state = agentCore.getState()
      const uptime = Date.now() - server.startTime

      // 从 cost-tracker 获取真实数据
      const totalCostUsd = getTotalCost()
      const inputTokens = getTotalInputTokens()
      const outputTokens = getTotalOutputTokens()
      const cacheReadTokens = getTotalCacheReadInputTokens()
      const cacheCreationTokens = getTotalCacheCreationInputTokens()
      const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens

      // 构建精简的 modelUsage 映射
      const rawModelUsage = getModelUsage()
      const modelUsage: Record<string, ModelUsageEntry> = {}
      for (const [model, usage] of Object.entries(rawModelUsage)) {
        modelUsage[model] = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          costUSD: usage.costUSD,
        }
      }

      return {
        // LLM 成本
        totalCostUsd,
        modelUsage,
        // Token 统计
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        totalTokens,
        // 性能耗时
        apiDurationMs: getTotalAPIDuration(),
        apiDurationWithoutRetriesMs: getTotalAPIDurationWithoutRetries(),
        toolDurationMs: getTotalToolDuration(),
        // 代码变更
        linesAdded: getTotalLinesAdded(),
        linesRemoved: getTotalLinesRemoved(),
        // 会话
        totalSessions: sessions.length,
        activeSession: state.sessionId !== '',
        uptime,
        // 系统
        memoryUsage: process.memoryUsage(),
      }
    },
  )

  // ─── getStatus ─────────────────────────────────────────────────────────────

  server.registerMethod(
    'getStatus',
    async (_params: unknown): Promise<StatusResult> => {
      const state = agentCore.getState()

      return {
        status: 'ready',
        sessionId: state.sessionId || undefined,
      }
    },
  )

  // ─── getHealth ─────────────────────────────────────────────────────────────

  server.registerMethod(
    'getHealth',
    async (_params: unknown): Promise<HealthResult> => {
      const uptime = Date.now() - server.startTime

      return {
        healthy: true,
        timestamp: Date.now(),
        uptime,
        version: '1.0.0',
      }
    },
  )

  // ─── getCostHistory ────────────────────────────────────────────────────────

  server.registerMethod('getCostHistory', async (_params: unknown) => {
    // 先保存当前会话数据到 history（确保最新数据在内）
    saveCurrentSessionCosts()

    return {
      history: getCostHistory(),
      byMonth: aggregateCostByMonth(),
      byWeek: aggregateCostByWeek(),
    }
  })
}
