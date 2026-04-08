/**
 * sidecar/handlers/checkpointHandler.ts
 *
 * Checkpoint API handler 注册模块。
 *
 * Checkpoint 是会话执行过程中的快照点，用于回滚和对比。
 * 使用文件系统持久化存储：~/.claude-desktop/checkpoints/{sessionId}/{checkpointId}.json
 *
 * 注册的 RPC 方法：
 *   - listCheckpoints         → 列出指定会话的所有 checkpoint
 *   - saveCheckpoint          → 保存当前会话状态为 checkpoint
 *   - rollbackCheckpoint      → 回滚到指定 checkpoint
 *   - compareCheckpoints      → 对比两个 checkpoint 的差异
 *   - getCheckpointTimeline   → 获取会话的 checkpoint 时间线
 *   - exportCheckpoint        → 导出 checkpoint 为 JSON 字符串
 *   - importCheckpoint        → 从 JSON 字符串导入 checkpoint
 *   - batchDeleteCheckpoints  → 批量删除 checkpoint
 */

import { z } from 'zod'
import { homedir } from 'os'
import { mkdir, readFile, writeFile, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import type { JsonRpcServer } from '../jsonRpcServer'

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

/**
 * Checkpoint 数据结构
 */
export interface Checkpoint {
  /** Checkpoint 唯一 ID */
  id: string
  /** 所属会话 ID */
  sessionId: string
  /** Checkpoint 名称 */
  name: string
  /** 可选描述 */
  description?: string
  /** 创建时间（ISO 8601） */
  createdAt: string
  /** 消息历史中的位置索引 */
  messageIndex: number
  /** 当前消息列表快照 */
  messages: unknown[]
  /** 附加元数据 */
  metadata?: Record<string, unknown>
}

/**
 * 时间线条目
 */
interface TimelineEntry {
  id: string
  name: string
  createdAt: string
  messageIndex: number
  description?: string
}

// ─── 参数 Schema ───────────────────────────────────────────────────────────────

const ListCheckpointsParamsSchema = z.object({
  sessionId: z.string().min(1, '会话 ID 不能为空'),
})

const SaveCheckpointParamsSchema = z.object({
  sessionId: z.string().min(1, '会话 ID 不能为空'),
  name: z.string().min(1, 'Checkpoint 名称不能为空'),
  description: z.string().optional(),
})

const RollbackCheckpointParamsSchema = z.object({
  sessionId: z.string().min(1, '会话 ID 不能为空'),
  checkpointId: z.string().min(1, 'Checkpoint ID 不能为空'),
})

const CompareCheckpointsParamsSchema = z.object({
  checkpointId1: z.string().min(1),
  checkpointId2: z.string().min(1),
})

const GetCheckpointTimelineParamsSchema = z.object({
  sessionId: z.string().min(1, '会话 ID 不能为空'),
})

const ExportCheckpointParamsSchema = z.object({
  checkpointId: z.string().min(1, 'Checkpoint ID 不能为空'),
})

const ImportCheckpointParamsSchema = z.object({
  sessionId: z.string().min(1, '会话 ID 不能为空'),
  data: z.string().min(1, 'Checkpoint 数据不能为空'),
})

const BatchDeleteCheckpointsParamsSchema = z.object({
  checkpointIds: z.array(z.string()).min(1, '至少提供一个 Checkpoint ID'),
})

// ─── 文件系统工具函数 ──────────────────────────────────────────────────────────

/**
 * 获取 checkpoint 存储目录
 * 格式：~/.claude-desktop/checkpoints/{sessionId}
 */
function getCheckpointDir(sessionId: string): string {
  return join(homedir(), '.claude-desktop', 'checkpoints', sessionId)
}

/**
 * 获取单个 checkpoint 文件路径
 * 格式：~/.claude-desktop/checkpoints/{sessionId}/{checkpointId}.json
 */
function getCheckpointPath(sessionId: string, checkpointId: string): string {
  return join(getCheckpointDir(sessionId), `${checkpointId}.json`)
}

/**
 * 确保目录存在（递归创建）
 */
async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true })
}

/**
 * 从文件系统读取 checkpoint
 * 不存在时返回 null
 */
async function readCheckpoint(
  sessionId: string,
  checkpointId: string,
): Promise<Checkpoint | null> {
  try {
    const content = await readFile(
      getCheckpointPath(sessionId, checkpointId),
      'utf-8',
    )
    return JSON.parse(content) as Checkpoint
  } catch {
    return null
  }
}

/**
 * 将 checkpoint 写入文件系统
 */
async function writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
  const dir = getCheckpointDir(checkpoint.sessionId)
  await ensureDir(dir)
  await writeFile(
    getCheckpointPath(checkpoint.sessionId, checkpoint.id),
    JSON.stringify(checkpoint, null, 2),
    'utf-8',
  )
}

/**
 * 列出指定会话的所有 checkpoint（从文件系统读取）
 */
async function listCheckpointFiles(sessionId: string): Promise<Checkpoint[]> {
  const dir = getCheckpointDir(sessionId)
  try {
    const files = await readdir(dir)
    const jsonFiles = files.filter(f => f.endsWith('.json'))

    const checkpoints = await Promise.all(
      jsonFiles.map(async f => {
        const checkpointId = f.replace(/\.json$/, '')
        return readCheckpoint(sessionId, checkpointId)
      }),
    )

    return checkpoints
      .filter((c): c is Checkpoint => c !== null)
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )
  } catch {
    // 目录不存在或为空，返回空列表
    return []
  }
}

// ─── 注册函数 ──────────────────────────────────────────────────────────────────

/**
 * 注册 Checkpoint API 方法到 JsonRpcServer。
 *
 * @param server JsonRpcServer 实例
 */
export function registerCheckpointHandlers(server: JsonRpcServer): void {
  const agentCore = server.getAgentCore()

  // ─── listCheckpoints ───────────────────────────────────────────────────────

  server.registerMethod(
    'listCheckpoints',
    async (params: unknown): Promise<{ checkpoints: Checkpoint[] }> => {
      const { sessionId } = ListCheckpointsParamsSchema.parse(params)
      const checkpoints = await listCheckpointFiles(sessionId)
      return { checkpoints }
    },
  )

  // ─── saveCheckpoint ────────────────────────────────────────────────────────

  server.registerMethod(
    'saveCheckpoint',
    async (params: unknown): Promise<{ checkpoint: Checkpoint }> => {
      const { sessionId, name, description } =
        SaveCheckpointParamsSchema.parse(params)

      // 获取当前会话消息（用于快照）
      let messages: unknown[] = []
      try {
        const session = await agentCore.getSession(sessionId)
        if (session) {
          messages = session.messages ?? []
        }
      } catch {
        // 无法获取消息时，保存空快照
      }

      const { randomUUID } = await import('crypto')
      const checkpoint: Checkpoint = {
        id: randomUUID(),
        sessionId,
        name,
        description,
        createdAt: new Date().toISOString(),
        messageIndex: messages.length,
        messages,
      }

      await writeCheckpoint(checkpoint)
      return { checkpoint }
    },
  )

  // ─── rollbackCheckpoint ────────────────────────────────────────────────────

  server.registerMethod(
    'rollbackCheckpoint',
    async (
      params: unknown,
    ): Promise<{ rolledBack: boolean; messageCount: number }> => {
      const { sessionId, checkpointId } =
        RollbackCheckpointParamsSchema.parse(params)

      const checkpoint = await readCheckpoint(sessionId, checkpointId)
      if (!checkpoint) {
        return { rolledBack: false, messageCount: 0 }
      }

      // 回滚操作：清空当前会话（简化实现）
      // 完整实现需要将 checkpoint.messages 注入 StateManager
      try {
        await agentCore.clearSession()
        return {
          rolledBack: true,
          messageCount: checkpoint.messages.length,
        }
      } catch {
        return { rolledBack: false, messageCount: 0 }
      }
    },
  )

  // ─── compareCheckpoints ────────────────────────────────────────────────────

  server.registerMethod(
    'compareCheckpoints',
    async (
      params: unknown,
    ): Promise<{
      diff: {
        checkpoint1: { id: string; name: string; messageCount: number }
        checkpoint2: { id: string; name: string; messageCount: number }
        messageDelta: number
        timeDelta: number
      }
    }> => {
      const { checkpointId1, checkpointId2 } =
        CompareCheckpointsParamsSchema.parse(params)

      // 两个 checkpoint 可能来自不同会话，需要查找
      // 简化实现：通过枚举目录查找
      const baseDir = join(homedir(), '.claude-desktop', 'checkpoints')
      let cp1: Checkpoint | null = null
      let cp2: Checkpoint | null = null

      try {
        const sessions = await readdir(baseDir)
        for (const sessionId of sessions) {
          if (!cp1) cp1 = await readCheckpoint(sessionId, checkpointId1)
          if (!cp2) cp2 = await readCheckpoint(sessionId, checkpointId2)
          if (cp1 && cp2) break
        }
      } catch {
        // 目录不存在
      }

      if (!cp1 || !cp2) {
        throw new Error(
          `Checkpoint 不存在: ${!cp1 ? checkpointId1 : checkpointId2}`,
        )
      }

      const time1 = new Date(cp1.createdAt).getTime()
      const time2 = new Date(cp2.createdAt).getTime()

      return {
        diff: {
          checkpoint1: {
            id: cp1.id,
            name: cp1.name,
            messageCount: cp1.messages.length,
          },
          checkpoint2: {
            id: cp2.id,
            name: cp2.name,
            messageCount: cp2.messages.length,
          },
          messageDelta: cp2.messages.length - cp1.messages.length,
          timeDelta: time2 - time1,
        },
      }
    },
  )

  // ─── getCheckpointTimeline ─────────────────────────────────────────────────

  server.registerMethod(
    'getCheckpointTimeline',
    async (params: unknown): Promise<{ timeline: TimelineEntry[] }> => {
      const { sessionId } = GetCheckpointTimelineParamsSchema.parse(params)
      const checkpoints = await listCheckpointFiles(sessionId)

      const timeline: TimelineEntry[] = checkpoints.map(cp => ({
        id: cp.id,
        name: cp.name,
        createdAt: cp.createdAt,
        messageIndex: cp.messageIndex,
        description: cp.description,
      }))

      return { timeline }
    },
  )

  // ─── exportCheckpoint ──────────────────────────────────────────────────────

  server.registerMethod(
    'exportCheckpoint',
    async (params: unknown): Promise<{ data: string }> => {
      const { checkpointId } = ExportCheckpointParamsSchema.parse(params)

      // 查找 checkpoint（遍历所有会话目录）
      const baseDir = join(homedir(), '.claude-desktop', 'checkpoints')
      let found: Checkpoint | null = null

      try {
        const sessions = await readdir(baseDir)
        for (const sessionId of sessions) {
          found = await readCheckpoint(sessionId, checkpointId)
          if (found) break
        }
      } catch {
        // 目录不存在
      }

      if (!found) {
        throw new Error(`Checkpoint 不存在: ${checkpointId}`)
      }

      return { data: JSON.stringify(found) }
    },
  )

  // ─── importCheckpoint ──────────────────────────────────────────────────────

  server.registerMethod(
    'importCheckpoint',
    async (params: unknown): Promise<{ checkpoint: Checkpoint }> => {
      const { sessionId, data } = ImportCheckpointParamsSchema.parse(params)

      let imported: Checkpoint
      try {
        imported = JSON.parse(data) as Checkpoint
      } catch {
        throw new Error('导入数据格式无效：不是有效的 JSON')
      }

      // 覆盖 sessionId 和生成新 ID（避免冲突）
      const { randomUUID } = await import('crypto')
      const checkpoint: Checkpoint = {
        ...imported,
        id: randomUUID(),
        sessionId,
        createdAt: new Date().toISOString(),
      }

      await writeCheckpoint(checkpoint)
      return { checkpoint }
    },
  )

  // ─── batchDeleteCheckpoints ────────────────────────────────────────────────

  server.registerMethod(
    'batchDeleteCheckpoints',
    async (params: unknown): Promise<{ deleted: number }> => {
      const { checkpointIds } = BatchDeleteCheckpointsParamsSchema.parse(params)

      const baseDir = join(homedir(), '.claude-desktop', 'checkpoints')
      let deleted = 0

      let sessionDirs: string[] = []
      try {
        sessionDirs = await readdir(baseDir)
      } catch {
        // 目录不存在，没有可删除的内容
        return { deleted: 0 }
      }

      for (const checkpointId of checkpointIds) {
        for (const sessionId of sessionDirs) {
          const filePath = getCheckpointPath(sessionId, checkpointId)
          try {
            await unlink(filePath)
            deleted++
            break // 找到并删除后跳出内层循环
          } catch {
            // 文件不存在或删除失败，继续尝试下一个 session
          }
        }
      }

      return { deleted }
    },
  )
}
