/**
 * sidecar/permissionBridge.ts
 *
 * 权限桥接模块：连接 AgentCore.onPermissionRequest 回调与 JSON-RPC 双向通信。
 *
 * 工作流程：
 * 1. AgentCore 触发 onPermissionRequest 回调
 * 2. PermissionBridge 生成唯一 requestId
 * 3. 通过 stdout 发送 `$/permissionRequest` JSON-RPC request（带 id）
 * 4. 等待 stdin 上来自 host 的对应响应
 * 5. 将 PermissionDecision 返回给 AgentCore
 *
 * 该模块不依赖 React/Ink，纯逻辑层。
 */

import { randomUUID } from 'crypto'
import type { PermissionRequest, PermissionDecision } from '../core/types'

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

/**
 * JSON-RPC 2.0 Request 消息格式
 */
interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

/**
 * JSON-RPC 2.0 Response 消息格式
 */
interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/**
 * 权限决策响应的 result 格式（来自 host）
 */
interface PermissionDecisionResult {
  granted: boolean
  remember?: boolean
  denyReason?: string
  answers?: Record<string, string>
  updatedInput?: Record<string, unknown>
}

/**
 * 等待中的权限请求：保存 resolve/reject 回调
 */
interface PendingPermissionRequest {
  resolve: (decision: PermissionDecision) => void
  reject: (error: Error) => void
  /** 超时计时器 ID */
  timeoutId: ReturnType<typeof setTimeout>
}

// ─── PermissionBridge 类 ───────────────────────────────────────────────────────

/**
 * PermissionBridge 负责将 AgentCore 的权限请求桥接到 JSON-RPC 双向通信。
 *
 * 使用方式：
 * ```typescript
 * const bridge = new PermissionBridge(writeLine);
 * agentCore.onPermissionRequest = bridge.createHandler();
 *
 * // 当收到来自 host 的权限响应时：
 * bridge.handleResponse(jsonRpcResponse);
 * ```
 */
export class PermissionBridge {
  /** 等待中的权限请求映射（rpcId → PendingPermissionRequest） */
  private pendingRequests = new Map<string | number, PendingPermissionRequest>()

  /** 权限请求超时时间（毫秒），默认 5 分钟 */
  private timeoutMs: number

  /** stdout 写入函数（由 JsonRpcServer 注入） */
  private writeLine: (line: string) => void

  /**
   * @param writeLine 向 stdout 写入一行 NDJSON 的函数
   * @param timeoutMs 等待 host 响应的超时时间（默认 300000ms = 5 分钟）
   */
  constructor(writeLine: (line: string) => void, timeoutMs = 300_000) {
    this.writeLine = writeLine
    this.timeoutMs = timeoutMs
  }

  // ─── 公共方法 ──────────────────────────────────────────────────────────────

  /**
   * 创建注入到 AgentCore.onPermissionRequest 的回调函数。
   *
   * 该回调在 AgentCore 遇到需要用户确认的操作时被调用，
   * 通过 JSON-RPC 请求将决策权转交给 Tauri host（前端）。
   */
  createHandler(): (request: PermissionRequest) => Promise<PermissionDecision> {
    return (request: PermissionRequest) => this.handlePermissionRequest(request)
  }

  /**
   * 处理来自 host 的 JSON-RPC 响应（权限决策）。
   *
   * 当 JsonRpcServer 收到 host 对 `$/permissionRequest` 的响应时，
   * 调用此方法将决策结果路由到对应的等待 Promise。
   *
   * @param response JSON-RPC 2.0 响应消息
   * @returns 是否成功处理（true = 找到对应的等待请求）
   */
  handleResponse(response: JsonRpcResponse): boolean {
    const pending = this.pendingRequests.get(response.id)
    if (!pending) {
      // 没有等待的请求，可能是超时后收到的迟到响应
      return false
    }

    // 清除超时计时器
    clearTimeout(pending.timeoutId)
    this.pendingRequests.delete(response.id)

    if (response.error) {
      // host 返回了错误响应
      pending.reject(
        new Error(
          `Host 权限响应错误 ${response.error.code}: ${response.error.message}`,
        ),
      )
      return true
    }

    // 解析权限决策结果
    const result = response.result as PermissionDecisionResult | undefined
    if (!result || typeof result.granted !== 'boolean') {
      pending.reject(new Error('Host 返回了无效的权限决策格式'))
      return true
    }

    pending.resolve({
      granted: result.granted,
      remember: result.remember,
      denyReason: result.denyReason,
      answers: result.answers,           // 新增
      updatedInput: result.updatedInput, // 新增
      decisionReason: result.granted
        ? { type: 'user', action: 'approved' }
        : { type: 'user', action: 'denied', reason: result.denyReason ?? 'User denied' },
    })
    return true
  }

  /**
   * 拒绝所有等待中的权限请求（关闭时调用）。
   *
   * @param reason 拒绝原因
   */
  rejectAll(reason = 'Sidecar 已关闭'): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId)
      pending.reject(new Error(reason))
      this.pendingRequests.delete(id)
    }
  }

  /**
   * 返回当前等待中的权限请求数量（用于诊断）。
   */
  get pendingCount(): number {
    return this.pendingRequests.size
  }

  // ─── 私有方法 ──────────────────────────────────────────────────────────────

  /**
   * 核心逻辑：将权限请求转为 JSON-RPC 请求发送给 host，等待响应。
   */
  private handlePermissionRequest(
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve, reject) => {
      // 生成唯一的 RPC 请求 ID（使用 UUID 保证唯一性）
      const rpcId = `perm-${randomUUID()}`

      // 构造 JSON-RPC 请求（注意：这是一个 request，不是 notification，所以带 id）
      const rpcRequest: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: rpcId,
        method: '$/permissionRequest',
        params: {
          requestId: request.requestId,
          tool: request.tool,
          action: request.action,
          path: request.path,
          description: request.description,
          toolInput: request.toolInput,
        },
      }

      // 设置超时（防止 host 无响应导致 AgentCore 永久阻塞）
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(rpcId)
        reject(
          new Error(
            `权限请求超时（${this.timeoutMs}ms）：工具 ${request.tool}，操作 ${request.action}`,
          ),
        )
      }, this.timeoutMs)

      // 注册等待项
      this.pendingRequests.set(rpcId, { resolve, reject, timeoutId })

      // 通过 stdout 发送 JSON-RPC 请求给 host
      try {
        this.writeLine(JSON.stringify(rpcRequest))
      } catch (err) {
        // 写入失败，立即清理
        clearTimeout(timeoutId)
        this.pendingRequests.delete(rpcId)
        reject(
          new Error(
            `发送权限请求到 host 失败: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
      }
    })
  }
}
