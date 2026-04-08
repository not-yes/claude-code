/**
 * sidecar/storage/sessionStorage.ts
 *
 * 会话数据文件系统持久化层。
 *
 * 存储结构：
 *   ~/.claude/sessions/
 *     sessions-index.json          # SessionMetadata[] 索引文件
 *     {sessionId}/
 *       metadata.json              # SessionMetadata
 *       messages.json              # unknown[] 消息数组
 *
 * 设计原则：
 * - 索引文件（sessions-index.json）只存元数据，不存消息，保持轻量
 * - 消息追加采用先读后写策略（单进程无并发冲突）
 * - 所有 I/O 方法均为幂等操作，失败时不抛出异常而是返回空值
 */

import { homedir } from 'os'
import { join } from 'path'
import { mkdir, readFile, writeFile, readdir, unlink, rm, stat } from 'fs/promises'
import { existsSync } from 'fs'

// ─── 常量 ──────────────────────────────────────────────────────────────────────

const STORAGE_DIR = join(homedir(), '.claude', 'sessions')
const INDEX_FILE = join(STORAGE_DIR, 'sessions-index.json')

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

export interface SessionMetadata {
  id: string
  name?: string
  model?: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface SessionData {
  metadata: SessionMetadata
  messages: unknown[]
}

// ─── SessionStorage 实现 ───────────────────────────────────────────────────────

/**
 * SessionStorage 负责会话数据的文件系统 CRUD 操作。
 *
 * 线程安全：此实现假定单进程单实例使用（Sidecar 模式）。
 * 如需多进程访问，应引入文件锁机制。
 */
export class SessionStorage {
  private readonly storageDir: string
  private readonly indexFile: string
  private initialized = false

  constructor(storageDir?: string) {
    this.storageDir = storageDir ?? STORAGE_DIR
    this.indexFile = join(this.storageDir, 'sessions-index.json')
  }

  // ─── 生命周期 ──────────────────────────────────────────────────────────

  /**
   * 初始化存储目录（幂等）。
   * 在首次使用前调用，确保目录存在。
   */
  async initialize(): Promise<void> {
    if (this.initialized) return
    try {
      await mkdir(this.storageDir, { recursive: true })
      // 若索引文件不存在，初始化为空数组
      if (!existsSync(this.indexFile)) {
        await writeFile(this.indexFile, JSON.stringify([], null, 2), 'utf-8')
      }
      this.initialized = true
    } catch (err) {
      // 目录创建失败不影响读操作，标记为已初始化避免重复尝试
      this.initialized = true
      throw new Error(
        `SessionStorage 初始化失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // ─── 索引管理（私有） ──────────────────────────────────────────────────

  /** 读取索引文件，失败时返回空数组 */
  private async readIndex(): Promise<SessionMetadata[]> {
    try {
      const raw = await readFile(this.indexFile, 'utf-8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /** 写入索引文件 */
  private async writeIndex(index: SessionMetadata[]): Promise<void> {
    await writeFile(this.indexFile, JSON.stringify(index, null, 2), 'utf-8')
  }

  /** 更新索引中指定会话的元数据（不存在则追加） */
  private async upsertIndex(metadata: SessionMetadata): Promise<void> {
    const index = await this.readIndex()
    const i = index.findIndex(m => m.id === metadata.id)
    if (i >= 0) {
      index[i] = metadata
    } else {
      index.unshift(metadata) // 新会话放最前面
    }
    // 按 updatedAt 降序排列
    index.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
    await this.writeIndex(index)
  }

  /** 从索引中删除指定会话 */
  private async removeFromIndex(id: string): Promise<void> {
    const index = await this.readIndex()
    const updated = index.filter(m => m.id !== id)
    await this.writeIndex(updated)
  }

  // ─── 会话目录路径 ──────────────────────────────────────────────────────

  private sessionDir(id: string): string {
    return join(this.storageDir, id)
  }

  private metadataPath(id: string): string {
    return join(this.sessionDir(id), 'metadata.json')
  }

  private messagesPath(id: string): string {
    return join(this.sessionDir(id), 'messages.json')
  }

  // ─── 公共 API ──────────────────────────────────────────────────────────

  /**
   * 保存会话（元数据 + 消息）。
   * 如果会话目录不存在则创建。
   */
  async saveSession(id: string, data: SessionData): Promise<void> {
    const dir = this.sessionDir(id)
    await mkdir(dir, { recursive: true })

    // 写入元数据和消息（并发写两个文件）
    await Promise.all([
      writeFile(this.metadataPath(id), JSON.stringify(data.metadata, null, 2), 'utf-8'),
      writeFile(this.messagesPath(id), JSON.stringify(data.messages, null, 2), 'utf-8'),
    ])

    // 更新索引
    await this.upsertIndex(data.metadata)
  }

  /**
   * 加载单个会话（含消息）。
   * 不存在或读取失败时返回 null。
   */
  async loadSession(id: string): Promise<SessionData | null> {
    try {
      const [metaRaw, msgsRaw] = await Promise.all([
        readFile(this.metadataPath(id), 'utf-8'),
        readFile(this.messagesPath(id), 'utf-8'),
      ])
      const metadata = JSON.parse(metaRaw) as SessionMetadata
      const messages = JSON.parse(msgsRaw) as unknown[]
      return { metadata, messages }
    } catch {
      return null
    }
  }

  /**
   * 列出所有会话元数据（不加载消息）。
   * 返回结果已按 updatedAt 降序排列。
   */
  async listSessions(): Promise<SessionMetadata[]> {
    return this.readIndex()
  }

  /**
   * 删除会话（删除目录 + 从索引移除）。
   * 会话不存在时返回 false，成功时返回 true。
   */
  async deleteSession(id: string): Promise<boolean> {
    const dir = this.sessionDir(id)
    try {
      // 先检查是否存在
      await stat(dir)
    } catch {
      // 目录不存在，从索引中清理并返回 false
      await this.removeFromIndex(id).catch(() => undefined)
      return false
    }

    try {
      // 删除整个会话目录
      await rm(dir, { recursive: true, force: true })
      await this.removeFromIndex(id)
      return true
    } catch {
      return false
    }
  }

  /**
   * 追加消息到会话（追加模式，先读后写）。
   * 同时更新 metadata.json 中的 messageCount 和 updatedAt。
   * 如果会话目录不存在，自动创建。
   */
  async appendMessage(sessionId: string, message: unknown): Promise<void> {
    const dir = this.sessionDir(sessionId)
    await mkdir(dir, { recursive: true })

    // 读取现有消息
    let messages: unknown[] = []
    try {
      const raw = await readFile(this.messagesPath(sessionId), 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) messages = parsed
    } catch {
      // 消息文件不存在时从空数组开始
    }

    // 追加新消息
    messages.push(message)
    const now = new Date().toISOString()

    // 读取现有元数据（如有）
    let metadata: SessionMetadata
    try {
      const raw = await readFile(this.metadataPath(sessionId), 'utf-8')
      metadata = JSON.parse(raw) as SessionMetadata
      metadata.messageCount = messages.length
      metadata.updatedAt = now
    } catch {
      // 元数据不存在时创建最小元数据
      metadata = {
        id: sessionId,
        createdAt: now,
        updatedAt: now,
        messageCount: messages.length,
      }
    }

    // 并发写入消息和元数据
    await Promise.all([
      writeFile(this.messagesPath(sessionId), JSON.stringify(messages, null, 2), 'utf-8'),
      writeFile(this.metadataPath(sessionId), JSON.stringify(metadata, null, 2), 'utf-8'),
    ])

    // 更新索引
    await this.upsertIndex(metadata)
  }

  /**
   * 获取会话消息列表。
   * 不存在时返回空数组。
   */
  async getMessages(sessionId: string): Promise<unknown[]> {
    try {
      const raw = await readFile(this.messagesPath(sessionId), 'utf-8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /**
   * 更新会话元数据（不修改消息）。
   * 用于更新会话名称、模型等信息。
   */
  async updateMetadata(
    id: string,
    updates: Partial<Pick<SessionMetadata, 'name' | 'model' | 'updatedAt'>>,
  ): Promise<void> {
    try {
      const raw = await readFile(this.metadataPath(id), 'utf-8')
      const metadata = JSON.parse(raw) as SessionMetadata
      const updated: SessionMetadata = {
        ...metadata,
        ...updates,
        updatedAt: updates.updatedAt ?? new Date().toISOString(),
      }
      await writeFile(this.metadataPath(id), JSON.stringify(updated, null, 2), 'utf-8')
      await this.upsertIndex(updated)
    } catch {
      // 元数据不存在时忽略
    }
  }

  /**
   * 扫描存储目录，修复索引与实际目录不一致的情况。
   * 在 initialize() 后可选调用，用于恢复意外中断导致的索引损坏。
   */
  async repairIndex(): Promise<void> {
    try {
      const entries = await readdir(this.storageDir, { withFileTypes: true })
      const dirIds = entries
        .filter(e => e.isDirectory())
        .map(e => e.name)

      // 加载每个目录的 metadata.json
      const metadataList: SessionMetadata[] = []
      for (const id of dirIds) {
        try {
          const raw = await readFile(this.metadataPath(id), 'utf-8')
          const meta = JSON.parse(raw) as SessionMetadata
          metadataList.push(meta)
        } catch {
          // 跳过无效目录
        }
      }

      // 按 updatedAt 降序排列
      metadataList.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
      await this.writeIndex(metadataList)
    } catch {
      // 修复失败时忽略，不影响正常运行
    }
  }
}
