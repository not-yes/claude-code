/**
 * sidecar/storage/checkpointStorage.ts
 *
 * Checkpoint 存储工具类。
 *
 * Checkpoint 数据由 checkpointHandler.ts 直接管理（文件系统存储），
 * 本类提供统计、清理等辅助功能，不重复实现 CRUD 逻辑。
 *
 * 存储路径（与 checkpointHandler.ts 保持一致）：
 *   ~/.claude/checkpoints/{sessionId}/{checkpointId}.json
 */

import { homedir } from 'os'
import { join } from 'path'
import { readdir, stat, unlink, rm } from 'fs/promises'
import { existsSync } from 'fs'

// ─── 常量 ──────────────────────────────────────────────────────────────────────

const CHECKPOINT_BASE_DIR = join(homedir(), '.claude', 'checkpoints')

// ─── CheckpointStorage 实现 ────────────────────────────────────────────────────

/**
 * CheckpointStorage 提供 checkpoint 数据的统计和运维工具。
 *
 * 核心 CRUD 操作（列表、保存、回滚、删除等）由 checkpointHandler.ts 直接处理，
 * 本类仅负责辅助性的聚合和清理功能。
 */
export class CheckpointStorage {
  private readonly baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? CHECKPOINT_BASE_DIR
  }

  /**
   * 获取指定会话的 checkpoint 存储目录路径。
   * 该路径与 checkpointHandler.ts 中的 getCheckpointDir() 保持一致。
   */
  async getStorageDir(sessionId: string): Promise<string> {
    return join(this.baseDir, sessionId)
  }

  /**
   * 获取所有 checkpoint 的存储统计信息。
   * 遍历所有会话目录，统计 checkpoint 总数和总字节数。
   */
  async getStorageStats(): Promise<{
    totalCheckpoints: number
    totalSizeBytes: number
  }> {
    let totalCheckpoints = 0
    let totalSizeBytes = 0

    if (!existsSync(this.baseDir)) {
      return { totalCheckpoints, totalSizeBytes }
    }

    try {
      const sessionDirs = await readdir(this.baseDir, { withFileTypes: true })

      for (const entry of sessionDirs) {
        if (!entry.isDirectory()) continue
        const sessionDir = join(this.baseDir, entry.name)

        try {
          const files = await readdir(sessionDir, { withFileTypes: true })
          for (const file of files) {
            if (!file.isFile() || !file.name.endsWith('.json')) continue
            try {
              const fileStat = await stat(join(sessionDir, file.name))
              totalCheckpoints++
              totalSizeBytes += fileStat.size
            } catch {
              // 跳过无法访问的文件
            }
          }
        } catch {
          // 跳过无法读取的会话目录
        }
      }
    } catch {
      // 基础目录不可读时返回零值
    }

    return { totalCheckpoints, totalSizeBytes }
  }

  /**
   * 清理指定日期之前创建的 checkpoint 文件。
   * 通过读取文件修改时间（mtime）进行判断。
   *
   * @param olderThan 清理此日期之前的 checkpoint
   * @returns 成功删除的 checkpoint 数量
   */
  async cleanup(olderThan: Date): Promise<number> {
    let deletedCount = 0
    const cutoffMs = olderThan.getTime()

    if (!existsSync(this.baseDir)) return 0

    try {
      const sessionDirs = await readdir(this.baseDir, { withFileTypes: true })

      for (const entry of sessionDirs) {
        if (!entry.isDirectory()) continue
        const sessionDir = join(this.baseDir, entry.name)

        try {
          const files = await readdir(sessionDir, { withFileTypes: true })
          for (const file of files) {
            if (!file.isFile() || !file.name.endsWith('.json')) continue
            const filePath = join(sessionDir, file.name)
            try {
              const fileStat = await stat(filePath)
              if (fileStat.mtimeMs < cutoffMs) {
                await unlink(filePath)
                deletedCount++
              }
            } catch {
              // 跳过无法访问或删除的文件
            }
          }

          // 如果会话目录已空，则删除目录
          try {
            const remaining = await readdir(sessionDir)
            if (remaining.length === 0) {
              await rm(sessionDir, { recursive: true, force: true })
            }
          } catch {
            // 目录删除失败不影响返回值
          }
        } catch {
          // 跳过无法读取的会话目录
        }
      }
    } catch {
      // 基础目录不可读时返回 0
    }

    return deletedCount
  }

  /**
   * 列出指定会话的所有 checkpoint ID。
   * 辅助方法，供统计或批量操作使用。
   */
  async listCheckpointIds(sessionId: string): Promise<string[]> {
    const sessionDir = join(this.baseDir, sessionId)
    if (!existsSync(sessionDir)) return []

    try {
      const files = await readdir(sessionDir, { withFileTypes: true })
      return files
        .filter(f => f.isFile() && f.name.endsWith('.json'))
        .map(f => f.name.replace(/\.json$/, ''))
    } catch {
      return []
    }
  }

  /**
   * 删除指定会话的所有 checkpoint（清空会话快照）。
   *
   * @returns 删除的 checkpoint 数量
   */
  async clearSessionCheckpoints(sessionId: string): Promise<number> {
    const sessionDir = join(this.baseDir, sessionId)
    if (!existsSync(sessionDir)) return 0

    try {
      const ids = await this.listCheckpointIds(sessionId)
      for (const id of ids) {
        await unlink(join(sessionDir, `${id}.json`)).catch(() => undefined)
      }
      await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined)
      return ids.length
    } catch {
      return 0
    }
  }
}
