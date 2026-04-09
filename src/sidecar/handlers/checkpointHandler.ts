/**
 * sidecar/handlers/checkpointHandler.ts
 *
 * Checkpoint API handler 注册模块。
 *
 * Checkpoint 是会话执行过程中的快照点，用于回滚和对比。
 * 使用文件系统持久化存储：~/.claude/checkpoints/{sessionId}/{checkpointId}.json
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

// ─── 内部存储类型定义 ───────────────────────────────────────────────────────────

/**
 * Checkpoint 内部数据结构（持久化存储）
 */
export interface Checkpoint {
  /** Checkpoint 唯一 ID */
  id: string
  /** 所属会话 ID */
  sessionId: string
  /** Checkpoint 标签（对应前端 tag） */
  tag: string
  /** 可选注释（对应前端 comment） */
  comment?: string
  /** 创建时间（ISO 8601） */
  createdAt: string
  /** 消息历史中的位置索引（对应前端 step） */
  messageIndex: number
  /** 当前消息列表快照 */
  messages: unknown[]
  /** 附加元数据 */
  metadata?: Record<string, unknown>
}

// ─── 前端 DTO 类型定义 ──────────────────────────────────────────────────────────

interface CheckpointListItem {
  id: string
  created_at: string
  step: number
  tags: string[]
  size_bytes: number
}

interface SaveCheckpointResult {
  checkpoint_id: string
  tag: string
  step: number
}

interface RollbackCheckpointResult {
  checkpoint_id: string
  step: number
  todos_count: number
  todos_done: number
}

interface TodoChanges {
  added: string[]
  removed: string[]
  completed: string[]
  reopened: string[]
}

interface ContextChanges {
  messages_added: number
  system_messages_changed: boolean
  last_user_message: string | null
  last_assistant_message: string | null
}

interface CompareCheckpointsResult {
  checkpoint_a_id: string
  checkpoint_b_id: string
  summary: string
  step_diff: number
  todo_diff: number
  context_window_diff: number
  todo_changes: TodoChanges
  context_changes: ContextChanges
}

interface CheckpointTimelineResult {
  timeline: string
  checkpoints: CheckpointListItem[]
}

interface ExportCheckpointResult {
  json_data: string
  metadata: {
    task_id: string
    checkpoint_id: string
    tags: string[]
    step: number
  }
}

interface ImportCheckpointResult {
  task_id: string
  checkpoint_id: string
  step: number
  tags: string[]
}

interface BatchDeleteCheckpointResult {
  checkpoint_id: string
  success: boolean
  error: string | null
}

// ─── 参数 Schema ───────────────────────────────────────────────────────────────

const ListCheckpointsParamsSchema = z.object({
  sessionId: z.string().min(1, '会话 ID 不能为空'),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
})

const SaveCheckpointParamsSchema = z.object({
  sessionId: z.string().min(1, '会话 ID 不能为空'),
  tag: z.string().min(1, 'Checkpoint tag 不能为空'),
  comment: z.string().optional(),
})

const RollbackCheckpointParamsSchema = z.object({
  sessionId: z.string().min(1, '会话 ID 不能为空'),
  checkpointId: z.string().min(1, 'Checkpoint ID 不能为空'),
})

const CompareCheckpointsParamsSchema = z.object({
  sessionId: z.string().min(1, '会话 ID 不能为空'),
  checkpointIdA: z.string().min(1),
  checkpointIdB: z.string().min(1),
})

const GetCheckpointTimelineParamsSchema = z.object({
  sessionId: z.string().min(1, '会话 ID 不能为空'),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
})

const ExportCheckpointParamsSchema = z.object({
  sessionId: z.string().min(1, '会话 ID 不能为空'),
  checkpointId: z.string().min(1, 'Checkpoint ID 不能为空'),
})

const ImportCheckpointParamsSchema = z.object({
  jsonData: z.string().min(1, 'Checkpoint 数据不能为空'),
})

const BatchDeleteCheckpointsParamsSchema = z.object({
  sessionId: z.string().min(1, '会话 ID 不能为空'),
  checkpointIds: z.array(z.string()).min(1, '至少提供一个 Checkpoint ID'),
})

// ─── 文件系统工具函数 ──────────────────────────────────────────────────────────

/**
 * 获取 checkpoint 存储目录
 * 格式：~/.claude/checkpoints/{sessionId}
 */
function getCheckpointDir(sessionId: string): string {
  return join(homedir(), '.claude', 'checkpoints', sessionId)
}

/**
 * 获取单个 checkpoint 文件路径
 * 格式：~/.claude/checkpoints/{sessionId}/{checkpointId}.json
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

/**
 * 将内部 Checkpoint 转换为前端 CheckpointListItem DTO
 */
function toCheckpointListItem(cp: Checkpoint): CheckpointListItem {
  return {
    id: cp.id,
    created_at: cp.createdAt,
    step: cp.messageIndex,
    tags: cp.tag ? [cp.tag] : [],
    size_bytes: 0,
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
    async (params: unknown): Promise<CheckpointListItem[]> => {
      const { sessionId, limit, offset = 0 } = ListCheckpointsParamsSchema.parse(params)
      let checkpoints = await listCheckpointFiles(sessionId)
      checkpoints = checkpoints.slice(offset, limit !== undefined ? offset + limit : undefined)
      return checkpoints.map(toCheckpointListItem)
    },
  )

  // ─── saveCheckpoint ────────────────────────────────────────────────────────

  server.registerMethod(
    'saveCheckpoint',
    async (params: unknown): Promise<SaveCheckpointResult> => {
      const { sessionId, tag, comment } = SaveCheckpointParamsSchema.parse(params)

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

      // 在保存前验证消息的可序列化性
      if (messages.length > 0) {
        try {
          JSON.stringify(messages)
        } catch (e) {
          return {
            checkpoint_id: '',
            tag,
            step: 0,
          }
        }
      }

      const { randomUUID } = await import('crypto')
      const checkpoint: Checkpoint = {
        id: randomUUID(),
        sessionId,
        tag,
        comment,
        createdAt: new Date().toISOString(),
        messageIndex: messages.length,
        messages,
      }

      await writeCheckpoint(checkpoint)

      return {
        checkpoint_id: checkpoint.id,
        tag: checkpoint.tag,
        step: checkpoint.messageIndex,
      }
    },
  )

  // ─── rollbackCheckpoint ────────────────────────────────────────────────────

  server.registerMethod(
    'rollbackCheckpoint',
    async (params: unknown): Promise<RollbackCheckpointResult> => {
      const { sessionId, checkpointId } = RollbackCheckpointParamsSchema.parse(params)

      const checkpoint = await readCheckpoint(sessionId, checkpointId)
      if (!checkpoint) {
        throw new Error(`Checkpoint 不存在: ${checkpointId}`)
      }

      // 回滚操作：恢复 checkpoint 中保存的消息状态
      try {
        if (checkpoint.messages && Array.isArray(checkpoint.messages) && checkpoint.messages.length > 0) {
          // 有消息快照时，恢复消息状态
          agentCore.restoreMessages(checkpoint.messages)
        } else {
          // checkpoint 没有消息数据时，回退到重置
          agentCore.resetConversation()
        }
        return {
          checkpoint_id: checkpoint.id,
          step: checkpoint.messageIndex,
          todos_count: 0,
          todos_done: 0,
        }
      } catch (err) {
        throw new Error(`回滚失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  )

  // ─── compareCheckpoints ────────────────────────────────────────────────────

  server.registerMethod(
    'compareCheckpoints',
    async (params: unknown): Promise<CompareCheckpointsResult> => {
      const { sessionId, checkpointIdA, checkpointIdB } = CompareCheckpointsParamsSchema.parse(params)

      const cp1 = await readCheckpoint(sessionId, checkpointIdA)
      const cp2 = await readCheckpoint(sessionId, checkpointIdB)

      if (!cp1) {
        throw new Error(`Checkpoint 不存在: ${checkpointIdA}`)
      }
      if (!cp2) {
        throw new Error(`Checkpoint 不存在: ${checkpointIdB}`)
      }

      const stepDiff = cp2.messageIndex - cp1.messageIndex
      const msgAdded = Math.max(0, stepDiff)

      // 尝试从消息列表中提取最后一条 user/assistant 消息
      const getLastMsg = (msgs: unknown[], role: string): string | null => {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i] as Record<string, unknown>
          if (m['role'] === role) {
            return typeof m['content'] === 'string' ? m['content'] : null
          }
        }
        return null
      }

      return {
        checkpoint_a_id: cp1.id,
        checkpoint_b_id: cp2.id,
        summary: `从 step ${cp1.messageIndex} 到 step ${cp2.messageIndex}，差距 ${Math.abs(stepDiff)} 步`,
        step_diff: stepDiff,
        todo_diff: 0,
        context_window_diff: msgAdded,
        todo_changes: {
          added: [],
          removed: [],
          completed: [],
          reopened: [],
        },
        context_changes: {
          messages_added: msgAdded,
          system_messages_changed: false,
          last_user_message: getLastMsg(cp2.messages, 'user'),
          last_assistant_message: getLastMsg(cp2.messages, 'assistant'),
        },
      }
    },
  )

  // ─── getCheckpointTimeline ─────────────────────────────────────────────────

  server.registerMethod(
    'getCheckpointTimeline',
    async (params: unknown): Promise<CheckpointTimelineResult> => {
      const { sessionId, limit, offset = 0 } = GetCheckpointTimelineParamsSchema.parse(params)
      let checkpoints = await listCheckpointFiles(sessionId)
      checkpoints = checkpoints.slice(offset, limit !== undefined ? offset + limit : undefined)

      const items = checkpoints.map(toCheckpointListItem)

      // 生成简单的文字时间线
      const timeline = checkpoints.length === 0
        ? '暂无 Checkpoint'
        : checkpoints
            .map((cp, i) => `[${i + 1}] ${cp.tag} (step ${cp.messageIndex}) @ ${cp.createdAt}`)
            .join('\n')

      return { timeline, checkpoints: items }
    },
  )

  // ─── exportCheckpoint ──────────────────────────────────────────────────────

  server.registerMethod(
    'exportCheckpoint',
    async (params: unknown): Promise<ExportCheckpointResult> => {
      const { sessionId, checkpointId } = ExportCheckpointParamsSchema.parse(params)

      const found = await readCheckpoint(sessionId, checkpointId)
      if (!found) {
        throw new Error(`Checkpoint 不存在: ${checkpointId}`)
      }

      return {
        json_data: JSON.stringify(found),
        metadata: {
          task_id: found.sessionId,
          checkpoint_id: found.id,
          tags: found.tag ? [found.tag] : [],
          step: found.messageIndex,
        },
      }
    },
  )

  // ─── importCheckpoint ──────────────────────────────────────────────────────

  server.registerMethod(
    'importCheckpoint',
    async (params: unknown): Promise<ImportCheckpointResult> => {
      const { jsonData } = ImportCheckpointParamsSchema.parse(params)

      let imported: Checkpoint
      try {
        imported = JSON.parse(jsonData) as Checkpoint
      } catch {
        throw new Error('导入数据格式无效：不是有效的 JSON')
      }

      // 生成新 ID（避免冲突）
      const { randomUUID } = await import('crypto')
      const checkpoint: Checkpoint = {
        ...imported,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      }

      await writeCheckpoint(checkpoint)

      return {
        task_id: checkpoint.sessionId,
        checkpoint_id: checkpoint.id,
        step: checkpoint.messageIndex,
        tags: checkpoint.tag ? [checkpoint.tag] : [],
      }
    },
  )

  // ─── batchDeleteCheckpoints ────────────────────────────────────────────────

  server.registerMethod(
    'batchDeleteCheckpoints',
    async (params: unknown): Promise<BatchDeleteCheckpointResult[]> => {
      const { sessionId, checkpointIds } = BatchDeleteCheckpointsParamsSchema.parse(params)

      const results: BatchDeleteCheckpointResult[] = []

      for (const checkpointId of checkpointIds) {
        const filePath = getCheckpointPath(sessionId, checkpointId)
        try {
          await unlink(filePath)
          results.push({ checkpoint_id: checkpointId, success: true, error: null })
        } catch (err) {
          results.push({
            checkpoint_id: checkpointId,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      return results
    },
  )
}
