/**
 * core/transport/Transport.ts
 *
 * 统一传输接口定义。
 *
 * 设计原则：
 * 1. CLI 模式（DirectTransport）和 Sidecar 模式（JsonRpcTransport）都实现此接口
 * 2. 调用方无需关心底层通信方式，通过统一的 Transport 接口与 Agent 交互
 * 3. 本文件不依赖任何 React/Ink 模块
 *
 * 与现有代码的关系：
 *   - SidecarStreamEvent、ExecuteOptions 等类型来自 core/types.ts
 *   - 会话管理方法对应 AgentCore 中的 createSession/getSession/listSessions
 *   - 工具查询方法对应 AgentCore.listTools()
 */

import type {
  SidecarStreamEvent,
  ExecuteOptions,
  Session,
  SessionParams,
  PermissionRequest,
  PermissionDecision,
} from '../types.js'

/**
 * 统一传输接口 - CLI 和 Sidecar 模式都通过此接口通信。
 *
 * 典型使用方式：
 * ```typescript
 * const transport = await createTransport();
 * await transport.initialize();
 *
 * // 注入权限回调
 * transport.onPermissionRequest(async (req) => {
 *   console.log(`权限请求：${req.tool} - ${req.action}`);
 *   return { granted: true };
 * });
 *
 * // 执行查询
 * for await (const event of transport.execute('请分析这个文件')) {
 *   if (event.type === 'text') process.stdout.write(event.content);
 *   if (event.type === 'complete') break;
 * }
 *
 * await transport.close();
 * ```
 */
export interface Transport {
  // ─── 核心执行 ──────────────────────────────────────────────────────────────

  /**
   * 执行查询，以 AsyncGenerator 形式流式返回事件。
   *
   * @param content 用户输入内容
   * @param options 执行选项（模型、权限模式、最大轮次等）
   * @yields SidecarStreamEvent 流式事件序列，以 type='complete' 事件结束
   */
  execute(
    content: string,
    options?: ExecuteOptions,
  ): AsyncGenerator<SidecarStreamEvent>

  // ─── 会话管理 ──────────────────────────────────────────────────────────────

  /**
   * 创建新会话。
   *
   * @param params 会话创建参数（名称、模型、system prompt、工作目录等）
   * @returns 新创建的会话元数据
   */
  createSession(params?: SessionParams): Promise<Session>

  /**
   * 按 ID 获取已有会话。
   *
   * @param id 会话 UUID
   * @returns 会话元数据，若不存在则抛出错误
   */
  getSession(id: string): Promise<Session>

  /**
   * 列出所有已保存的会话。
   *
   * @returns 会话列表（按创建时间倒序）
   */
  listSessions(): Promise<Session[]>

  // ─── Checkpoint 管理 ────────────────────────────────────────────────────────

  /**
   * 保存当前会话的检查点（快照）。
   *
   * @param sessionId 会话 UUID
   * @param tag 可选的标签（如 'before-refactor'）
   * @returns 检查点 ID，用于后续 rollbackCheckpoint
   */
  saveCheckpoint(sessionId: string, tag?: string): Promise<string>

  /**
   * 回滚到指定检查点。
   * 会话的消息历史将恢复到检查点时的状态。
   *
   * @param checkpointId 检查点 ID（由 saveCheckpoint 返回）
   */
  rollbackCheckpoint(checkpointId: string): Promise<void>

  // ─── 工具/Agent/Skill 查询 ──────────────────────────────────────────────────

  /**
   * 列出当前可用的所有工具。
   *
   * @returns 工具信息列表（name + description）
   */
  listTools(): Promise<Array<{ name: string; description: string }>>

  /**
   * 列出当前可用的所有 Agent。
   *
   * @returns Agent 信息列表（name + description）
   */
  listAgents(): Promise<Array<{ name: string; description: string }>>

  /**
   * 列出当前可用的所有 Skill。
   *
   * @returns Skill 信息列表（name + description）
   */
  listSkills(): Promise<Array<{ name: string; description: string }>>

  // ─── 权限回调（双向通信） ──────────────────────────────────────────────────

  /**
   * 注册权限请求回调（双向通信）。
   *
   * 当 Agent 执行需要用户确认的操作时，会调用此回调。
   * CLI 模式：DirectTransport 将其转发给 AgentCore.onPermissionRequest。
   * Sidecar 模式：JsonRpcTransport 将 $/permissionRequest 消息路由到此回调。
   *
   * @param handler 权限决策函数，接收 PermissionRequest，返回 PermissionDecision
   */
  onPermissionRequest(
    handler: (request: PermissionRequest) => Promise<PermissionDecision>,
  ): void

  // ─── 生命周期 ──────────────────────────────────────────────────────────────

  /**
   * 初始化 Transport（连接 AgentCore、建立 I/O 监听等）。
   * 必须在首次调用其他方法前完成。
   */
  initialize(): Promise<void>

  /**
   * 优雅关闭 Transport（清理资源、发送关闭通知等）。
   */
  close(): Promise<void>

  // ─── 状态查询 ──────────────────────────────────────────────────────────────

  /**
   * 查询 Transport 是否已就绪（initialize 完成且未关闭）。
   *
   * @returns true 表示可以调用 execute 等方法
   */
  isReady(): boolean
}
