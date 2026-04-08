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
import type { JsonRpcServer } from '../jsonRpcServer'

// ─── 参数 Schema ───────────────────────────────────────────────────────────────

const GetSessionsParamsSchema = z.object({
  agent_id: z.string().optional(),
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

interface SessionMessage {
  id?: string
  role: 'user' | 'assistant'
  content: string
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
  [key: string]: unknown
}

interface DeleteSessionResult {
  deleted: boolean
}

interface StatsResult {
  totalSessions: number
  activeSession: boolean
  uptime: number
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

      try {
        const sessions = await agentCore.listSessions()
        // 过滤和截断
        const result = sessions
          .filter(s => {
            // 如果指定 agent_id 且不是 'default'，对于当前单 Agent 实现返回全部
            return true
          })
          .slice(0, limit)

        return result.map(s => ({
          id: s.id,
          title: s.metadata?.['name'] as string | undefined,
          task: undefined,
          agent_id: parsed.agent_id ?? 'default',
          created_at: s.createdAt,
          updated_at: s.updatedAt,
        }))
      } catch {
        return []
      }
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
          return {
            id: msg['id'] as string | undefined,
            role: (msg['role'] as 'user' | 'assistant') ?? 'user',
            content: typeof msg['content'] === 'string' ? msg['content'] : String(msg['content'] ?? ''),
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
        // 直接调用 AgentCore.getSession() 检查是否存在
        const session = await agentCore.getSession(sessionId)
        if (!session) {
          return { deleted: false }
        }
        // 调用 clearSession() 清空会话消息历史
        // 注： clearSession() 内部会删除持久化文件
        await agentCore.clearSession()
        return { deleted: true }
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

      return {
        totalSessions: sessions.length,
        activeSession: state.sessionId !== '',
        uptime,
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
}
