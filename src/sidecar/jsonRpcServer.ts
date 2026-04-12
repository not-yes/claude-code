/**
 * sidecar/jsonRpcServer.ts
 *
 * JSON-RPC 2.0 核心服务：接收 stdin 上的 JSON-RPC 请求，路由到对应处理方法，
 * 将响应和流事件通过 stdout 发送给 Tauri host。
 *
 * 消息格式：NDJSON（每行一条 JSON-RPC 2.0 消息）
 *
 * 支持的 RPC 方法（内置 9 个，通过 registerMethod 可扩展）：
 *   - execute           → 流式执行查询
 *   - createSession     → 创建新会话
 *   - getSession        → 获取已有会话
 *   - listSessions      → 列出所有会话
 *   - listTools         → 列出可用工具
 *   - abort             → 中止当前执行
 *   - ping              → 心跳检测（Rust LifecycleManager 定期调用）
 *   - shutdown          → 优雅关闭
 *   - permissionResponse → 接收来自 host 的权限决策回传
 *
 * 双向通信（Server → Client）：
 *   - `$/stream`          → 流式事件 notification
 *   - `$/complete`        → 流结束 notification
 *   - `$/streamError`     → 流错误 notification
 *   - `$/permissionRequest` → 权限请求（带 id，等待响应）
 *
 * 无 React/Ink 依赖，纯 Node.js stdin/stdout 处理。
 *
 * 方法路由采用 Map<string, MethodHandler> 模式，支持通过 registerMethod() 动态注册。
 */

import { createInterface } from 'readline'
import { z } from 'zod'
import type { AgentCore } from '../core/AgentCore'
import {
  StreamHandler,
  ActiveStreamRegistry,
  createBackpressureWriter,
  createSyncWriter,
} from './streamHandler'
import { PermissionBridge } from './permissionBridge'
import type { ExecuteOptions, SessionParams } from '../core/types'
import {
  registerSessionHandlers,
  registerCheckpointHandlers,
  registerCronHandlers,
  registerAgentHandlers,
  registerSkillHandlers,
  registerMcpHandlers,
} from './handlers/index'

// ─── JSON-RPC 2.0 类型定义 ─────────────────────────────────────────────────────

/**
 * JSON-RPC 2.0 错误码（遵循规范定义）
 */
const RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** 自定义：AgentCore 未初始化 */
  NOT_INITIALIZED: -32000,
  /** 自定义：执行 ID 不存在 */
  EXECUTE_ID_NOT_FOUND: -32001,
  /** 自定义：方法调用时序错误 */
  SEQUENCE_ERROR: -32002,
} as const

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// ─── Zod 输入校验 Schema ───────────────────────────────────────────────────────

/** execute 方法参数 schema */
const ExecuteParamsSchema = z.object({
  /** 用户输入内容（必填） */
  content: z.string().min(1, '内容不能为空'),
  /** 执行 ID（由 host 提供，用于关联流事件；不提供则自动生成） */
  executeId: z.string().optional(),
  /** 执行选项（可选） */
  options: z
    .object({
      model: z.string().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      systemPrompt: z.string().optional(),
      appendSystemPrompt: z.string().optional(),
      allowedTools: z.array(z.string()).optional(),
      permissionMode: z
        .enum(['auto-approve', 'interactive', 'plan-only', 'deny-all'])
        .optional(),
      maxTurns: z.number().int().positive().optional(),
      enableThinking: z.boolean().optional(),
      requestId: z.string().optional(),
      /** Agent ID - 加载对应 agent 的 skills 和配置 */
      agentId: z.string().optional(),
    })
    .optional(),
})

/** createSession 方法参数 schema */
const CreateSessionParamsSchema = z.object({
  name: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  cwd: z.string().optional(),
})

/** getSession 方法参数 schema */
const GetSessionParamsSchema = z.object({
  id: z.string().min(1, '会话 ID 不能为空'),
})

/** abort 方法参数 schema */
const AbortParamsSchema = z.object({
  /** 指定要中止的 executeId（不指定则中止所有） */
  executeId: z.string().optional(),
})

// ─── JsonRpcServer 类 ─────────────────────────────────────────────────────────

/** RPC 方法处理器类型 */
export type MethodHandler = (params: unknown) => Promise<unknown>

/**
 * JsonRpcServer 配置选项
 */
export interface JsonRpcServerOptions {
  /** 是否打印调试日志到 stderr */
  debug?: boolean
  /** 权限请求超时时间（毫秒），默认 5 分钟 */
  permissionTimeoutMs?: number
}

/**
 * JsonRpcServer：Sidecar 进程的核心通信层。
 *
 * 通过 readline 逐行读取 stdin，解析 NDJSON 格式的 JSON-RPC 2.0 消息，
 * 路由到对应的处理方法，并将结果写入 stdout。
 */
export class JsonRpcServer {
  private agentCore: AgentCore
  private options: Required<JsonRpcServerOptions>
  private permissionBridge: PermissionBridge
  private streamRegistry: ActiveStreamRegistry
  private writeLine: (line: string) => Promise<void>
  private syncWriteLine: (line: string) => void
  private rl: ReturnType<typeof createInterface> | null = null
  private isRunning = false
  /** 动态方法路由表：方法名 → 处理器 */
  private methodRegistry = new Map<string, MethodHandler>()
  /** Cron 调度器引用（启动后通过 setScheduler 注入） */
  private schedulerRef: { current?: { refreshSchedule: () => void } } = {}
  /** 服务器启动时间（用于 uptime 计算） */
  readonly startTime = Date.now()

  constructor(agentCore: AgentCore, options: JsonRpcServerOptions = {}) {
    this.agentCore = agentCore
    this.options = {
      debug: options.debug ?? false,
      permissionTimeoutMs: options.permissionTimeoutMs ?? 300_000,
    }

    // 提高 stdout maxListeners，避免长任务流式事件触发 MaxListenersExceeded 警告
    process.stdout.setMaxListeners(100)

    // 创建背压感知的写入函数（用于流事件）
    this.writeLine = createBackpressureWriter(process.stdout)
    // 同步写入（用于权限请求，消息体小）
    this.syncWriteLine = createSyncWriter(process.stdout)

    // 初始化权限桥接
    this.permissionBridge = new PermissionBridge(
      this.syncWriteLine,
      this.options.permissionTimeoutMs,
    )

    // 初始化流注册表
    this.streamRegistry = new ActiveStreamRegistry()

    // 将 PermissionBridge 回调注入 AgentCore
    this.agentCore.onPermissionRequest = this.permissionBridge.createHandler()

    // 注册扩展 handlers（会话扩展 API + Checkpoint API + Cron + Agent + Skill）
    registerSessionHandlers(this)
    registerCheckpointHandlers(this)
    registerCronHandlers(this, this.schedulerRef)
    registerAgentHandlers(this, this.agentCore)
    registerSkillHandlers(this, this.agentCore)
    registerMcpHandlers(this, this.agentCore)

    // 注册内置扩展方法
    this.registerMethod('resetConversation', async (): Promise<{ success: boolean }> => {
      try {
        this.agentCore.resetConversation()
        return { success: true }
      } catch {
        return { success: false }
      }
    })

    this.registerMethod('getState', async (): Promise<Record<string, unknown>> => {
      const state = agentCore.getState?.() ?? {}
      return {
        sessionId: (state as any).sessionId ?? null,
        permissionMode: (state as any).permissionMode ?? null,
        isInitialized: true,
      }
    })
  }

  /**
   * 向路由表动态注册一个 RPC 方法。
   * 供外部 handler 模块调用，将方法名与处理函数绑定。
   *
   * @param name    RPC 方法名
   * @param handler 异步处理函数，接收 params，返回 result
   */
  registerMethod(name: string, handler: MethodHandler): void {
    this.methodRegistry.set(name, handler)
  }

  /**
   * 暴露 agentCore 给 handler 模块使用（只读访问）
   */
  getAgentCore(): AgentCore {
    return this.agentCore
  }

  /**
   * 注入 Cron 调度器引用，使 CRUD handler 可在任务变更后调用 refreshSchedule()。
   * 在 server.start() 之后、Cron 调度器创建后调用。
   */
  setScheduler(scheduler: { refreshSchedule: () => void }): void {
    this.schedulerRef.current = scheduler
  }

  // ─── 生命周期 ──────────────────────────────────────────────────────────────

  /**
   * 启动服务，开始监听 stdin。
   */
  start(): void {
    if (this.isRunning) return
    this.isRunning = true

    this.debugLog('JsonRpcServer 已启动，监听 stdin...')

    // 使用 readline 逐行读取 stdin（NDJSON 格式）
    this.rl = createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
      // 关闭 terminal 模式（Sidecar 模式下 stdin 是管道，不是 TTY）
      terminal: false,
    })

    this.rl.on('line', (line: string) => {
      // 每行是一个独立的 JSON-RPC 消息
      const trimmed = line.trim()
      if (!trimmed) return // 忽略空行
      this.handleRawLine(trimmed)
    })

    this.rl.on('close', () => {
      this.debugLog('stdin 已关闭，服务停止')
      this.isRunning = false
    })

    this.rl.on('error', (err: Error) => {
      this.debugLog('readline 错误:', err.message)
    })
  }

  /**
   * 停止服务，清理资源。
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return
    this.isRunning = false

    // 中止所有活跃流
    await this.streamRegistry.abortAll('服务停止')

    // 拒绝所有等待中的权限请求
    this.permissionBridge.rejectAll('服务停止')

    // 关闭 readline
    if (this.rl) {
      this.rl.close()
      this.rl = null
    }

    this.debugLog('JsonRpcServer 已停止')
  }

  // ─── 消息处理入口 ──────────────────────────────────────────────────────────

  /**
   * 处理 stdin 上收到的原始 JSON 行。
   * 解析后分发到：RPC 请求处理 或 权限响应处理。
   */
  private handleRawLine(rawLine: string): void {
    process.stderr.write(`[JsonRpcServer] handleRawLine: 收到行(前100字符): ${rawLine.slice(0, 100)}\n`)
    let parsed: unknown
    try {
      parsed = JSON.parse(rawLine)
    } catch (e) {
      // 解析失败，发送 parse error（id 为 null）
      this.sendResponseSync({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: RPC_ERROR.PARSE_ERROR,
          message: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
        },
      })
      return
    }

    const msg = parsed as Record<string, unknown>

    // 判断消息类型：
    // - 有 id 且有 result/error → 这是对 server 发出 request 的 response（如权限响应）
    // - 有 method → 这是 client 发来的 request 或 notification
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      // 这是对服务器发出的 `$/permissionRequest` 的响应
      const response = msg as {
        jsonrpc: string
        id: string | number
        result?: unknown
        error?: unknown
      }
      const handled = this.permissionBridge.handleResponse({
        jsonrpc: '2.0',
        id: response.id,
        result: response.result,
        error: response.error as { code: number; message: string } | undefined,
      })
      if (!handled) {
        this.debugLog('收到未知 id 的响应消息，忽略:', response.id)
      }
      return
    }

    if (typeof msg.method !== 'string') {
      this.sendResponseSync({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: RPC_ERROR.INVALID_REQUEST,
          message: '无效的 JSON-RPC 请求：缺少 method 字段',
        },
      })
      return
    }

    // 处理 RPC 请求（异步，不阻塞 readline）
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: msg.id as string | number | null | undefined,
      method: msg.method,
      params: msg.params,
    }

    // 异步处理，错误会在 handleRequest 内部捕获并发送错误响应
    this.handleRequest(request).catch(err => {
      this.debugLog('handleRequest 未捕获错误:', err)
    })
  }

  /**
   * 将 JSON-RPC 请求路由到对应的处理方法。
   */
  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    const { id, method, params } = request
    const reqId = id ?? null

    this.debugLog(`收到请求: ${method} (id=${reqId})`)

    try {
      let result: unknown

      switch (method) {
        case 'execute':
          // execute 是特殊的流式方法，它自己负责发送 notification，
          // 最终发送一个简单的 ack response（或不发送，取决于协议约定）
          await this.handleExecute(reqId, params)
          return // execute 内部已处理响应

        case 'createSession':
          result = await this.handleCreateSession(params)
          break

        case 'getSession':
          result = await this.handleGetSession(params)
          break

        case 'listSessions':
          result = await this.handleListSessions()
          break

        case 'listTools':
          result = this.handleListTools()
          break

        case 'abort':
          result = await this.handleAbort(params)
          break

        case 'ping':
          result = await this.handlePing()
          break

        case 'shutdown':
          result = await this.handleShutdown()
          break

        case 'permissionResponse':
          result = await this.handlePermissionResponse(params)
          break

        default: {
          // 检查动态注册的方法路由表
          const dynamicHandler = this.methodRegistry.get(method)
          if (dynamicHandler) {
            result = await dynamicHandler(params)
            break
          }

          // 未知方法：如果是 notification（无 id），静默忽略；否则返回错误
          if (reqId !== null) {
            await this.sendResponse({
              jsonrpc: '2.0',
              id: reqId,
              error: {
                code: RPC_ERROR.METHOD_NOT_FOUND,
                message: `未知方法: ${method}`,
              },
            })
          }
          return
        }
      }

      // 发送成功响应（仅对 request，notification 无 id 则忽略）
      if (reqId !== null) {
        await this.sendResponse({
          jsonrpc: '2.0',
          id: reqId,
          result: result ?? null,  // undefined → null，确保 JSON 序列化包含 result 字段
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const isZodError = err instanceof z.ZodError

      if (reqId !== null) {
        await this.sendResponse({
          jsonrpc: '2.0',
          id: reqId,
          error: {
            code: isZodError ? RPC_ERROR.INVALID_PARAMS : RPC_ERROR.INTERNAL_ERROR,
            message: isZodError ? `参数校验失败: ${err.message}` : message,
            data: isZodError ? err.errors : undefined,
          },
        })
      }
    }
  }

  // ─── RPC 方法处理器 ────────────────────────────────────────────────────────

  /**
   * 处理 `execute` 请求。
   *
   * 特殊说明：execute 是流式方法。
   * - 先发送 ack 响应（告知 host 请求已接受，executeId 是多少）
   * - 然后异步消费 AgentCore.execute() 的事件流
   * - 每个事件通过 `$/stream` notification 发送
   * - 流结束通过 `$/complete` 或 `$/streamError` 通知
   */
  private async handleExecute(
    reqId: string | number | null,
    params: unknown,
  ): Promise<void> {
    // 校验参数
    const parsed = ExecuteParamsSchema.parse(params)
    const { content, options } = parsed

    // 生成 executeId（使用 host 提供的或自动生成）
    const { randomUUID } = await import('crypto')
    const executeId = parsed.executeId ?? randomUUID()

    process.stderr.write(
      `[JsonRpcServer] handleExecute: 收到 execute 请求 reqId=${reqId} executeId=${executeId} content前50: ${content.slice(0, 50)}\n`
    )

    // 立即发送 ack 响应（告知 host execute 已接受，以及 executeId）
    if (reqId !== null) {
      await this.sendResponse({
        jsonrpc: '2.0',
        id: reqId,
        result: { executeId, status: 'accepted' },
      })
    }

    // 异步执行流式查询（不阻塞后续 RPC 请求的处理）
    this.runExecuteStream(executeId, content, options).catch(err => {
      this.debugLog(`[${executeId}] 流执行异常:`, err)
      process.stderr.write(`[JsonRpcServer] runExecuteStream 异常 executeId=${executeId}: ${err}\n`)
    })
  }

  /**
   * 异步运行流式执行，注册到注册表，完成后注销。
   */
  private async runExecuteStream(
    executeId: string,
    content: string,
    options?: ExecuteOptions,
  ): Promise<void> {
    // 创建流处理器（使用背压写入）
    const handler = new StreamHandler(this.writeLine, {
      debug: this.options.debug,
    })

    // 启动 generator（不 await，稍后注册）
    const generator = this.agentCore.execute(content, options)

    // 注册到活跃流注册表
    this.streamRegistry.register(executeId, generator, handler, this.agentCore)

    try {
      // 消费流（内部处理所有 notification 发送）
      const result = await handler.handle(executeId, generator)
      this.debugLog(
        `[${executeId}] 流执行完成: success=${result.success}, events=${result.eventCount}`,
      )
    } catch (error) {
      // 捕获流启动或运行期间的未预期异常（handler.handle 内部通常自己处理错误，
      // 此处为双保险：防止 StreamHandler 外层抛出的错误导致客户端永远收不到结束信号）
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.debugLog(`[${executeId}] 流执行异常（外层捕获）:`, errorMsg)

      // 通知客户端流启动/运行失败
      try {
        const notification = JSON.stringify({
          jsonrpc: '2.0',
          method: '$/streamError',
          params: {
            executeId,
            message: errorMsg,
            code: 'STREAM_START_FAILED',
          },
        })
        await this.writeLine(notification)
      } catch (writeErr) {
        // stdout 写入失败（进程可能正在关闭），只记录日志
        this.debugLog(`[${executeId}] 发送流启动失败通知失败:`, writeErr)
      }
    } finally {
      // 无论成功还是失败，都要注销
      this.streamRegistry.unregister(executeId)
    }
  }

  /**
   * 处理 `createSession` 请求
   */
  private async handleCreateSession(params: unknown): Promise<unknown> {
    const parsed = params
      ? CreateSessionParamsSchema.parse(params)
      : undefined
    const sessionParams: SessionParams | undefined = parsed

    const session = await this.agentCore.createSession(sessionParams)
    return session
  }

  /**
   * 处理 `getSession` 请求
   */
  private async handleGetSession(params: unknown): Promise<unknown> {
    const { id } = GetSessionParamsSchema.parse(params)
    const session = await this.agentCore.getSession(id)

    if (!session) {
      throw Object.assign(new Error(`会话不存在: ${id}`), {
        code: RPC_ERROR.EXECUTE_ID_NOT_FOUND,
      })
    }

    return session
  }

  /**
   * 处理 `listSessions` 请求
   */
  private async handleListSessions(): Promise<unknown> {
    const sessions = await this.agentCore.listSessions()
    return { sessions }
  }

  /**
   * 处理 `listTools` 请求
   */
  private handleListTools(): unknown {
    const tools = this.agentCore.listTools()
    return { tools }
  }

  /**
   * 处理 `abort` 请求
   */
  private async handleAbort(params: unknown): Promise<unknown> {
    const parsed = params ? AbortParamsSchema.parse(params) : {}
    const { executeId } = parsed

    if (executeId) {
      // 中止指定的执行
      const aborted = await this.streamRegistry.abort(executeId)
      return { aborted, executeId }
    } else {
      // 中止所有执行
      const count = this.streamRegistry.count
      await this.streamRegistry.abortAll('用户请求中止')
      this.agentCore.abort()
      return { aborted: count > 0, count }
    }
  }

  /**
   * 处理心跳 ping 请求。
   * 返回简单的健康状态信息，供 Rust LifecycleManager 判断 sidecar 是否存活。
   */
  private async handlePing(): Promise<unknown> {
    return { status: 'ok', timestamp: Date.now() }
  }

  /**
   * 处理优雅关闭请求。
   * 按序执行：停止活跃流 → 拒绝待处理权限 → AgentCore.shutdown() → 退出进程。
   * Rust LifecycleManager 关闭第一阶段发送此消息，避免走 SIGKILL 路径。
   */
  private async handleShutdown(): Promise<unknown> {
    this.debugLog('收到 shutdown 请求，开始优雅关闭')

    // 停止服务器（清理活跃流、拒绝待处理权限）
    await this.stop()

    // 关闭 AgentCore
    await this.agentCore.shutdown()

    // 延迟一小段时间确保响应已发出，再退出进程
    setTimeout(() => process.exit(0), 100)

    return { status: 'shutting_down' }
  }

  /**
   * 处理来自 host 的权限决策回传。
   * 前端通过 Rust 转发权限决策，最终以 `permissionResponse` RPC 方法到达此处。
   * 将决策路由到 PermissionBridge，唤醒等待中的权限请求 Promise。
   */
  private async handlePermissionResponse(params: unknown): Promise<unknown> {
    const parsed = z
      .object({
        requestId: z.string(),
        decision: z.object({
          granted: z.boolean(),
          remember: z.boolean().optional(),
          denyReason: z.string().optional(),
        }),
      })
      .parse(params)

    // 将决策路由给 PermissionBridge，使用 requestId 作为 rpcId 匹配等待中的请求
    const handled = this.permissionBridge.handleResponse({
      jsonrpc: '2.0',
      id: parsed.requestId,
      result: parsed.decision,
    })

    if (!handled) {
      this.debugLog('permissionResponse: 未找到匹配的待处理权限请求，requestId=', parsed.requestId)
    }

    return { ok: true }
  }

  // ─── 响应发送工具方法 ──────────────────────────────────────────────────────

  /**
   * 异步发送 JSON-RPC 响应（带背压控制）
   */
  /**
   * 发送 JSON-RPC notification（无 id，服务端主动推送）
   */
  async sendNotification(method: string, params: unknown): Promise<void> {
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    })
    await this.writeLine(notification)
  }

  private async sendResponse(response: JsonRpcResponse): Promise<void> {
    await this.writeLine(JSON.stringify(response))
  }

  /**
   * 同步发送 JSON-RPC 响应（用于错误快速反馈，消息体小）
   */
  private sendResponseSync(response: JsonRpcResponse): void {
    this.syncWriteLine(JSON.stringify(response))
  }

  /**
   * 输出调试日志到 stderr（不污染 stdout 协议）
   */
  private debugLog(...args: unknown[]): void {
    if (this.options.debug) {
      process.stderr.write(`[JsonRpcServer] ${args.join(' ')}\n`)
    }
  }
}

