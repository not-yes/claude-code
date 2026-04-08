/**
 * core/transport/DirectTransport.ts
 *
 * CLI 模式下的直接传输实现。
 *
 * 设计原则：
 * 1. 直接调用 AgentCore 方法，无任何序列化/反序列化开销
 * 2. Checkpoint 功能通过内存 Map 实现（轻量快照）
 * 3. Agent/Skill 查询通过扫描约定目录实现
 * 4. 本文件不依赖任何 React/Ink 模块
 *
 * 与现有代码的关系：
 *   - agentCore.execute() 对应 QueryEngine.submitMessage()
 *   - agentCore.listTools() 对应 getTools() 返回的工具列表
 *   - Checkpoint 功能为新增，复用会话 messages 数组快照
 */

import type { Transport } from './Transport.js'
import type { AgentCore } from '../AgentCore.js'
import type {
  SidecarStreamEvent,
  ExecuteOptions,
  Session,
  SessionParams,
  PermissionRequest,
  PermissionDecision,
} from '../types.js'
import { randomUUID } from 'crypto'

// ─── Checkpoint 内部类型 ────────────────────────────────────────────────────────

/**
 * 检查点快照结构（内存存储）。
 */
interface CheckpointSnapshot {
  /** 检查点唯一 ID */
  id: string
  /** 对应会话 ID */
  sessionId: string
  /** 可选标签（用于识别） */
  tag?: string
  /** 创建时间 */
  createdAt: string
  /** 快照的消息历史（深拷贝） */
  messages: unknown[]
  /** 快照的会话元数据 */
  sessionMeta: Omit<Session, 'messages'>
}

// ─── DirectTransport 实现 ──────────────────────────────────────────────────────

/**
 * 直接传输实现 - CLI 模式下使用。
 *
 * 直接调用 AgentCore 方法，无序列化/反序列化开销。
 * 所有方法均为同步代理或简单的内存操作，适合嵌入式 CLI 场景。
 */
export class DirectTransport implements Transport {
  /** 底层 AgentCore 实例 */
  private agentCore: AgentCore

  /** 是否已就绪 */
  private ready = false

  /** 内存中的检查点存储：checkpointId -> CheckpointSnapshot */
  private checkpoints = new Map<string, CheckpointSnapshot>()

  /** 内存中的会话存储（由 createSession 维护）：sessionId -> Session */
  private sessions = new Map<string, Session>()

  constructor(agentCore: AgentCore) {
    this.agentCore = agentCore
  }

  // ─── 生命周期 ────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    await this.agentCore.initialize()
    this.ready = true
  }

  async close(): Promise<void> {
    await this.agentCore.shutdown()
    this.ready = false
  }

  isReady(): boolean {
    return this.ready
  }

  // ─── 核心执行 ────────────────────────────────────────────────────────────────

  /**
   * 直接代理到 AgentCore.execute()。
   * CLI 模式下零开销，事件直接从 AgentCore 传出。
   */
  async *execute(
    content: string,
    options?: ExecuteOptions,
  ): AsyncGenerator<SidecarStreamEvent> {
    this.assertReady()
    yield* this.agentCore.execute(content, options)
  }

  // ─── 会话管理 ────────────────────────────────────────────────────────────────

  /**
   * 创建新会话，并写入内存 sessions Map。
   */
  async createSession(params?: SessionParams): Promise<Session> {
    this.assertReady()
    const session = await this.agentCore.createSession(params)
    this.sessions.set(session.id, session)
    return session
  }

  /**
   * 按 ID 获取会话。
   * 优先从内存 Map 查找，若不存在则调用 agentCore.getSession() 并尝试回落。
   */
  async getSession(id: string): Promise<Session> {
    // 优先从本地内存查找
    const local = this.sessions.get(id)
    if (local) return local

    // 委托给 AgentCore（可能返回 null）
    const remote = await this.agentCore.getSession(id)
    if (remote) {
      this.sessions.set(remote.id, remote)
      return remote
    }

    throw new Error(`会话不存在：${id}`)
  }

  /**
   * 列出所有会话（合并内存中的会话列表 + AgentCore 的持久化列表）。
   */
  async listSessions(): Promise<Session[]> {
    // 先从 AgentCore 获取持久化列表
    const persisted = await this.agentCore.listSessions()

    // 合并内存中的会话（以内存为准，避免重复）
    const merged = new Map<string, Session>()
    for (const s of persisted) merged.set(s.id, s)
    for (const [id, s] of this.sessions) merged.set(id, s)

    // 按 updatedAt 倒序排列
    return Array.from(merged.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
  }

  // ─── Checkpoint 管理 ──────────────────────────────────────────────────────────

  /**
   * 保存会话检查点（内存快照）。
   *
   * 将当前会话的 messages 数组进行深拷贝，存入内存 checkpoints Map。
   * 适合 CLI 场景的轻量实现，进程退出后检查点会丢失。
   *
   * @param sessionId 要快照的会话 ID
   * @param tag 可选标签（便于人工识别）
   * @returns 生成的检查点 UUID
   */
  async saveCheckpoint(sessionId: string, tag?: string): Promise<string> {
    const session = await this.getSession(sessionId)

    const checkpointId = randomUUID()
    const snapshot: CheckpointSnapshot = {
      id: checkpointId,
      sessionId,
      tag,
      createdAt: new Date().toISOString(),
      // 深拷贝消息历史（避免后续操作污染快照）
      messages: JSON.parse(JSON.stringify(session.messages)),
      sessionMeta: {
        id: session.id,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        metadata: session.metadata ? JSON.parse(JSON.stringify(session.metadata)) : undefined,
      },
    }

    this.checkpoints.set(checkpointId, snapshot)
    return checkpointId
  }

  /**
   * 回滚到指定检查点。
   *
   * 从内存 checkpoints Map 中取出快照，将对应会话的消息历史恢复到快照时的状态。
   *
   * @param checkpointId 检查点 UUID（由 saveCheckpoint 返回）
   */
  async rollbackCheckpoint(checkpointId: string): Promise<void> {
    const snapshot = this.checkpoints.get(checkpointId)
    if (!snapshot) {
      throw new Error(`检查点不存在：${checkpointId}`)
    }

    // 恢复会话（从快照重建 Session 对象）
    const restored: Session = {
      ...snapshot.sessionMeta,
      updatedAt: new Date().toISOString(), // 更新时间戳
      messages: JSON.parse(JSON.stringify(snapshot.messages)),
    }

    this.sessions.set(snapshot.sessionId, restored)

    // 同时清空 AgentCore 的内部会话状态（调用 clearSession）
    await this.agentCore.clearSession()
  }

  // ─── 工具/Agent/Skill 查询 ───────────────────────────────────────────────────

  /**
   * 列出所有可用工具。
   * 直接调用 AgentCore.listTools()，转换为 Transport 接口约定的格式。
   */
  async listTools(): Promise<Array<{ name: string; description: string }>> {
    this.assertReady()
    const tools = this.agentCore.listTools()
    return tools.map(t => ({
      name: t.name,
      description: t.description,
    }))
  }

  /**
   * 列出所有可用 Agent。
   *
   * AgentCore 当前未直接暴露 Agent 列表，此处通过扫描 .claude/agents/ 目录实现。
   * 若目录不存在，返回内置 Agent 占位列表。
   */
  async listAgents(): Promise<Array<{ name: string; description: string }>> {
    this.assertReady()
    try {
      // 尝试扫描 .claude/agents/ 目录获取自定义 Agent
      const { readdir, readFile } = await import('fs/promises')
      const { join } = await import('path')

      // 内置 Agent（对应 AgentTool 中的 built-in agents）
      const builtinAgents = [
        { name: 'explore', description: '探索代码库，生成文件结构和架构概览' },
        { name: 'plan', description: '制定任务实施计划（只读规划模式）' },
        { name: 'verification', description: '验证任务完成情况，运行测试和校验' },
      ]

      // 扫描 .claude/agents 目录
      const agentsDir = join(process.cwd(), '.claude', 'agents')
      let customAgents: Array<{ name: string; description: string }> = []

      try {
        const files = await readdir(agentsDir)
        const mdFiles = files.filter(f => f.endsWith('.md'))

        customAgents = await Promise.all(
          mdFiles.map(async file => {
            const name = file.replace(/\.md$/, '')
            try {
              const content = await readFile(join(agentsDir, file), 'utf-8')
              // 提取 YAML front matter 中的 description 字段
              const descMatch = content.match(/^description:\s*(.+)$/m)
              const description = descMatch ? descMatch[1].trim() : `自定义 Agent：${name}`
              return { name, description }
            } catch {
              return { name, description: `自定义 Agent：${name}` }
            }
          }),
        )
      } catch {
        // .claude/agents 目录不存在，忽略错误
      }

      return [...builtinAgents, ...customAgents]
    } catch {
      // 降级：返回内置 Agent 列表
      return [
        { name: 'explore', description: '探索代码库，生成文件结构和架构概览' },
        { name: 'plan', description: '制定任务实施计划（只读规划模式）' },
        { name: 'verification', description: '验证任务完成情况，运行测试和校验' },
      ]
    }
  }

  /**
   * 列出所有可用 Skill。
   *
   * 通过扫描 .claude/skills/ 目录获取 Skill 列表。
   * 若目录不存在，返回空列表。
   */
  async listSkills(): Promise<Array<{ name: string; description: string }>> {
    this.assertReady()
    try {
      const { readdir, readFile } = await import('fs/promises')
      const { join } = await import('path')

      const skillsDir = join(process.cwd(), '.claude', 'skills')
      const files = await readdir(skillsDir)
      const mdFiles = files.filter(f => f.endsWith('.md'))

      const skills = await Promise.all(
        mdFiles.map(async file => {
          const name = file.replace(/\.md$/, '')
          try {
            const content = await readFile(join(skillsDir, file), 'utf-8')
            // 提取 YAML front matter 中的 description 字段
            const descMatch = content.match(/^description:\s*(.+)$/m)
            const description = descMatch ? descMatch[1].trim() : `Skill：${name}`
            return { name, description }
          } catch {
            return { name, description: `Skill：${name}` }
          }
        }),
      )

      return skills
    } catch {
      // 目录不存在或读取失败，返回空列表
      return []
    }
  }

  // ─── 权限回调 ────────────────────────────────────────────────────────────────

  /**
   * 注册权限请求回调。
   * 直接绑定到 AgentCore.onPermissionRequest，无中间层。
   */
  onPermissionRequest(
    handler: (request: PermissionRequest) => Promise<PermissionDecision>,
  ): void {
    this.agentCore.onPermissionRequest = handler
  }

  // ─── 私有辅助方法 ────────────────────────────────────────────────────────────

  /**
   * 断言 Transport 已就绪，否则抛出错误。
   */
  private assertReady(): void {
    if (!this.ready) {
      throw new Error('DirectTransport 尚未初始化，请先调用 initialize()')
    }
  }
}
