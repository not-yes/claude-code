/**
 * core/transport/JsonRpcTransport.ts
 *
 * Sidecar 模式下通过 stdin/stdout JSON-RPC 通信的传输实现。
 *
 * 协议规范：
 * 1. 消息格式：NDJSON（Newline-Delimited JSON），每行一条 JSON-RPC 2.0 消息
 * 2. 请求（host → sidecar）：带 id 字段的 JSON-RPC request
 * 3. 响应（sidecar → host）：带 id 字段、result 或 error 的 JSON-RPC response
 * 4. 通知（双向）：不带 id 的 JSON-RPC notification
 *
 * 流式 execute 协议（核心难点）：
 * 1. host 发送 execute 请求（带 id）
 * 2. sidecar 收到后，通过 $/stream notification 逐个推送 SidecarStreamEvent
 * 3. 最后发送 $/complete notification（或 $/streamError）结束流
 * 4. 权限请求：sidecar 发送 $/permissionRequest 请求，等待 host 回应
 *
 * 背压处理：
 * - 使用有界事件队列（maxQueueSize），超出时暂停 stdin
 * - 消费方通过 generator.next() 拉取时恢复 stdin
 *
 * 本文件不依赖任何 React/Ink 模块。
 */

import type { Transport } from './Transport.js'
import type {
  SidecarStreamEvent,
  ExecuteOptions,
  Session,
  SessionParams,
  PermissionRequest,
  PermissionDecision,
} from '../types.js'

// ─── JSON-RPC 类型定义 ─────────────────────────────────────────────────────────

/**
 * JSON-RPC 2.0 消息结构。
 * 同时表示 request、response 和 notification（id 为 undefined 时为 notification）。
 */
interface JsonRpcMessage {
  jsonrpc: '2.0'
  /** 请求 ID（request 和 response 有，notification 无） */
  id?: string | number
  /** 方法名（request 和 notification 有） */
  method?: string
  /** 请求参数 */
  params?: unknown
  /** 成功响应结果 */
  result?: unknown
  /** 错误响应 */
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

// ─── 事件队列类型 ──────────────────────────────────────────────────────────────

/**
 * 流式事件队列中的项目。
 * 使用 discriminated union 表示数据、错误和完成三种状态。
 */
type StreamQueueItem =
  | { kind: 'event'; event: SidecarStreamEvent }
  | { kind: 'error'; error: Error }
  | { kind: 'done' }

/**
 * 正在进行的流式执行的状态追踪。
 */
interface ActiveStream {
  /** 事件队列（未被消费方取走的事件缓存） */
  queue: StreamQueueItem[]
  /** 当消费方等待新事件时，保存 resolve 函数（异步唤醒机制） */
  waiter: ((item: StreamQueueItem) => void) | null
}

// ─── JsonRpcTransport 实现 ────────────────────────────────────────────────────

/**
 * JSON-RPC 传输实现 - Sidecar 模式下使用。
 *
 * 通过 stdin/stdout 进行双向 JSON-RPC 通信（NDJSON 格式）。
 * 支持流式 execute（通过 notification 推送事件）和权限请求双向通信。
 */
export class JsonRpcTransport implements Transport {
  /** stdin 输入流（接收来自 sidecar 进程的消息） */
  private stdin: NodeJS.ReadableStream

  /** stdout 输出流（向 sidecar 进程发送消息） */
  private stdout: NodeJS.WritableStream

  /** 是否已就绪 */
  private ready = false

  /** 自增请求 ID 计数器 */
  private requestId = 0

  /** 等待响应的 pending 请求：requestId -> { resolve, reject } */
  private pendingRequests = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >()

  /** 权限请求回调（由 onPermissionRequest 注册） */
  private permissionHandler?: (req: PermissionRequest) => Promise<PermissionDecision>

  /** 当前活跃的流式执行：executeRequestId -> ActiveStream */
  private activeStreams = new Map<number, ActiveStream>()

  /** 最大事件队列长度（背压控制阈值） */
  private readonly maxQueueSize: number

  /** stdin 是否已暂停（背压状态） */
  private stdinPaused = false

  /** NDJSON 解析缓冲区（处理跨 chunk 的行） */
  private buffer = ''

  constructor(
    stdin: NodeJS.ReadableStream,
    stdout: NodeJS.WritableStream,
    options?: { maxQueueSize?: number },
  ) {
    this.stdin = stdin
    this.stdout = stdout
    this.maxQueueSize = options?.maxQueueSize ?? 100
  }

  // ─── 生命周期 ──────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    // 监听 stdin 数据，解析 NDJSON 行
    this.stdin.on('data', (chunk: Buffer) => this.handleData(chunk))

    // 监听 stdin 关闭（sidecar 进程退出时处理）
    this.stdin.on('end', () => this.handleStdinEnd())
    this.stdin.on('error', (err: Error) => this.handleStdinError(err))

    this.ready = true
  }

  async close(): Promise<void> {
    // 向 sidecar 发送 shutdown notification
    this.sendNotification('shutdown')
    this.ready = false

    // 清理所有 pending 请求
    for (const [, { reject }] of this.pendingRequests) {
      reject(new Error('Transport 已关闭'))
    }
    this.pendingRequests.clear()

    // 清理所有活跃流（推送 done 事件唤醒等待中的 generator）
    for (const [, stream] of this.activeStreams) {
      this.pushToStream(stream, { kind: 'done' })
    }
    this.activeStreams.clear()
  }

  isReady(): boolean {
    return this.ready
  }

  // ─── 核心执行（AsyncGenerator 实现） ──────────────────────────────────────────

  /**
   * 执行查询，通过 JSON-RPC 通知接收流式事件。
   *
   * 实现原理（事件队列 + waiter 模式）：
   * 1. 发送 execute 请求，获取请求 ID
   * 2. 注册 ActiveStream（事件队列 + waiter）到 activeStreams Map
   * 3. Generator 每次 yield 时，调用 pullFromStream() 等待下一个事件
   * 4. 收到 $/stream notification 时，将事件 push 到对应队列
   * 5. 收到 $/complete 或 $/streamError 时，结束队列
   *
   * 背压控制：
   * - 队列长度超过 maxQueueSize 时，暂停 stdin（防止内存无限增长）
   * - 消费方每次 pull 后检查队列长度，低于阈值时恢复 stdin
   */
  async *execute(
    content: string,
    options?: ExecuteOptions,
  ): AsyncGenerator<SidecarStreamEvent> {
    this.assertReady()

    // 分配请求 ID（execute 用此 ID 关联后续的 $/stream notification）
    const id = ++this.requestId

    // 创建 ActiveStream 并注册
    const stream: ActiveStream = {
      queue: [],
      waiter: null,
    }
    this.activeStreams.set(id, stream)

    try {
      // 发送 execute 请求（不等待响应，响应通过 $/stream 异步到达）
      const message: JsonRpcMessage = {
        jsonrpc: '2.0',
        id,
        method: 'execute',
        params: { content, options },
      }
      this.writeMessage(message)

      // 循环拉取事件，直到 done 或 error
      while (true) {
        const item = await this.pullFromStream(stream, id)

        if (item.kind === 'done') {
          // 流正常结束
          break
        }

        if (item.kind === 'error') {
          // 流异常结束，向上抛出
          throw item.error
        }

        // 正常事件，yield 给消费方
        yield item.event

        // 如果是 complete 事件，提前结束（避免等待额外的 done）
        if (item.event.type === 'complete' || item.event.type === 'error') {
          break
        }
      }
    } finally {
      // 无论如何都清理 activeStreams
      this.activeStreams.delete(id)

      // 如果 stdin 因为这个流暂停了，现在可以恢复
      if (this.stdinPaused && this.shouldResume()) {
        this.resumeStdin()
      }
    }
  }

  // ─── 会话管理 ──────────────────────────────────────────────────────────────

  /** 创建新会话 */
  async createSession(params?: SessionParams): Promise<Session> {
    return this.sendRequest('createSession', params) as Promise<Session>
  }

  /** 获取指定 ID 的会话 */
  async getSession(id: string): Promise<Session> {
    const result = await this.sendRequest('getSession', { id })
    if (!result) throw new Error(`会话不存在：${id}`)
    return result as Session
  }

  /** 列出所有会话 */
  async listSessions(): Promise<Session[]> {
    return this.sendRequest('listSessions') as Promise<Session[]>
  }

  // ─── Checkpoint 管理 ────────────────────────────────────────────────────────

  /** 保存检查点 */
  async saveCheckpoint(sessionId: string, tag?: string): Promise<string> {
    return this.sendRequest('saveCheckpoint', { sessionId, tag }) as Promise<string>
  }

  /** 回滚到检查点 */
  async rollbackCheckpoint(checkpointId: string): Promise<void> {
    await this.sendRequest('rollbackCheckpoint', { checkpointId })
  }

  // ─── 工具/Agent/Skill 查询 ──────────────────────────────────────────────────

  /** 列出可用工具 */
  async listTools(): Promise<Array<{ name: string; description: string }>> {
    return this.sendRequest('listTools') as Promise<Array<{ name: string; description: string }>>
  }

  /** 列出可用 Agent */
  async listAgents(): Promise<Array<{ name: string; description: string }>> {
    return this.sendRequest('listAgents') as Promise<Array<{ name: string; description: string }>>
  }

  /** 列出可用 Skill */
  async listSkills(): Promise<Array<{ name: string; description: string }>> {
    return this.sendRequest('listSkills') as Promise<Array<{ name: string; description: string }>>
  }

  // ─── 权限回调 ────────────────────────────────────────────────────────────────

  /**
   * 注册权限请求回调。
   * 当收到 $/permissionRequest 消息时，将调用此回调，并将结果通过 JSON-RPC 响应返回。
   */
  onPermissionRequest(
    handler: (request: PermissionRequest) => Promise<PermissionDecision>,
  ): void {
    this.permissionHandler = handler
  }

  // ─── 私有方法：消息发送 ───────────────────────────────────────────────────────

  /**
   * 发送 JSON-RPC 请求，并等待对应响应。
   *
   * @param method 方法名
   * @param params 请求参数
   * @returns 响应结果（reject 时抛出 Error）
   */
  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.requestId
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })
      const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, params }
      this.writeMessage(message)
    })
  }

  /**
   * 发送 JSON-RPC Notification（不带 id，不等待响应）。
   *
   * @param method 方法名
   * @param params 参数
   */
  private sendNotification(method: string, params?: unknown): void {
    const message: JsonRpcMessage = { jsonrpc: '2.0', method, params }
    this.writeMessage(message)
  }

  /**
   * 将 JSON-RPC 消息序列化后写入 stdout（NDJSON 格式：每行一条消息）。
   */
  private writeMessage(message: JsonRpcMessage): void {
    try {
      this.stdout.write(JSON.stringify(message) + '\n')
    } catch (err) {
      // stdout 写入失败（sidecar 进程已退出）
      console.error('[JsonRpcTransport] stdout 写入失败：', err)
    }
  }

  // ─── 私有方法：消息接收 ───────────────────────────────────────────────────────

  /**
   * 处理 stdin 数据 chunk。
   *
   * 将 chunk 追加到缓冲区，按换行符分割，逐行解析 JSON-RPC 消息。
   * 处理跨 chunk 的行（buffer 保留不完整的最后一行）。
   */
  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8')

    // 按换行符切割，最后一个可能是不完整的行（保留在 buffer）
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage
        // 异步处理（permissionRequest 处理是 async 的）
        this.handleMessage(msg).catch(err => {
          console.error('[JsonRpcTransport] 消息处理失败：', err)
        })
      } catch {
        // JSON 解析失败，记录但不中断（容错处理）
        console.error('[JsonRpcTransport] JSON 解析失败，忽略行：', trimmed.slice(0, 100))
      }
    }
  }

  /**
   * stdin 关闭时，清理所有活跃资源。
   */
  private handleStdinEnd(): void {
    // 将所有 pending 请求 reject
    for (const [, { reject }] of this.pendingRequests) {
      reject(new Error('stdin 已关闭，sidecar 进程可能已退出'))
    }
    this.pendingRequests.clear()

    // 将所有活跃流标记为结束
    for (const [, stream] of this.activeStreams) {
      this.pushToStream(stream, { kind: 'done' })
    }
    this.activeStreams.clear()

    this.ready = false
  }

  /**
   * stdin 错误处理。
   */
  private handleStdinError(err: Error): void {
    for (const [, { reject }] of this.pendingRequests) {
      reject(err)
    }
    this.pendingRequests.clear()

    for (const [, stream] of this.activeStreams) {
      this.pushToStream(stream, { kind: 'error', error: err })
    }
    this.activeStreams.clear()

    this.ready = false
  }

  /**
   * 分发 JSON-RPC 消息到对应的处理器。
   *
   * 消息类型分类：
   * 1. 响应消息（有 id，有 result 或 error）→ 解除 pending 请求
   * 2. $/stream notification → push 到对应 activeStream
   * 3. $/complete notification → 标记流结束
   * 4. $/streamError notification → 标记流错误
   * 5. $/permissionRequest 请求（有 id）→ 调用权限回调并响应
   */
  private async handleMessage(msg: JsonRpcMessage): Promise<void> {
    // ─── 情况 1：响应消息（有 id + result/error，没有 method）────────────────
    if (msg.id !== undefined && msg.method === undefined) {
      const id = msg.id as number
      const pending = this.pendingRequests.get(id)
      if (pending) {
        this.pendingRequests.delete(id)
        if (msg.error) {
          pending.reject(new Error(msg.error.message))
        } else {
          pending.resolve(msg.result)
        }
      }
      return
    }

    // ─── 情况 2：$/stream notification（流式事件推送）──────────────────────
    if (msg.method === '$/stream' && msg.id === undefined) {
      const params = msg.params as { executeId: number; event: SidecarStreamEvent }
      if (!params) return

      const stream = this.activeStreams.get(params.executeId)
      if (!stream) return

      this.pushToStream(stream, { kind: 'event', event: params.event })

      // 背压控制：队列过长时暂停 stdin
      if (stream.queue.length > this.maxQueueSize && !this.stdinPaused) {
        this.pauseStdin()
      }
      return
    }

    // ─── 情况 3：$/complete notification（流正常结束）─────────────────────
    if (msg.method === '$/complete' && msg.id === undefined) {
      const params = msg.params as { executeId: number }
      if (!params) return

      const stream = this.activeStreams.get(params.executeId)
      if (stream) {
        this.pushToStream(stream, { kind: 'done' })
        // 注意：不在这里 delete activeStreams，由 execute() 的 finally 负责
      }
      return
    }

    // ─── 情况 4：$/streamError notification（流异常结束）──────────────────
    if (msg.method === '$/streamError' && msg.id === undefined) {
      const params = msg.params as { executeId: number; message: string; code?: string }
      if (!params) return

      const stream = this.activeStreams.get(params.executeId)
      if (stream) {
        this.pushToStream(stream, {
          kind: 'error',
          error: new Error(params.message),
        })
      }
      return
    }

    // ─── 情况 5：$/permissionRequest 请求（双向权限交互）──────────────────
    if (msg.method === '$/permissionRequest' && msg.id !== undefined) {
      const requestId = msg.id
      const permRequest = msg.params as PermissionRequest

      if (!this.permissionHandler) {
        // 无权限回调，默认拒绝（保守策略）
        const response: JsonRpcMessage = {
          jsonrpc: '2.0',
          id: requestId,
          result: { granted: false, denyReason: '调用方未注册权限回调' } satisfies PermissionDecision,
        }
        this.writeMessage(response)
        return
      }

      try {
        const decision = await this.permissionHandler(permRequest)
        const response: JsonRpcMessage = {
          jsonrpc: '2.0',
          id: requestId,
          result: decision,
        }
        this.writeMessage(response)
      } catch (err) {
        // 权限回调出错，返回错误响应
        const response: JsonRpcMessage = {
          jsonrpc: '2.0',
          id: requestId,
          error: {
            code: -32000,
            message: err instanceof Error ? err.message : String(err),
          },
        }
        this.writeMessage(response)
      }
      return
    }

    // 未知消息，忽略（容错）
  }

  // ─── 私有方法：流式事件队列 ──────────────────────────────────────────────────

  /**
   * 将事件 push 到 ActiveStream 的队列，并唤醒等待中的 waiter（如果有）。
   *
   * 唤醒逻辑：
   * - 如果 generator 已经在等待（waiter 不为 null），直接 resolve 并清空 waiter
   * - 否则将事件放入队列，由下次 pullFromStream 取走
   *
   * @param stream 目标活跃流
   * @param item 队列项目（event、error 或 done）
   */
  private pushToStream(stream: ActiveStream, item: StreamQueueItem): void {
    if (stream.waiter) {
      // generator 正在等待，直接唤醒
      const waiter = stream.waiter
      stream.waiter = null
      waiter(item)
    } else {
      // generator 还没来取，放入队列
      stream.queue.push(item)
    }
  }

  /**
   * 从 ActiveStream 的队列拉取下一个事件（如果队列为空则异步等待）。
   *
   * 实现方式：
   * 1. 如果队列有数据，立即返回队列头
   * 2. 如果队列为空，返回 Promise，等待 pushToStream 调用 waiter resolve
   *
   * 背压恢复：每次消费后检查队列长度，低于阈值时恢复 stdin。
   *
   * @param stream 目标活跃流
   * @param executeId 对应的 execute 请求 ID（用于背压判断）
   */
  private pullFromStream(stream: ActiveStream, executeId: number): Promise<StreamQueueItem> {
    // 队列有数据，直接取
    if (stream.queue.length > 0) {
      const item = stream.queue.shift()!

      // 消费后检查是否可以恢复 stdin
      if (this.stdinPaused && this.shouldResume()) {
        this.resumeStdin()
      }

      return Promise.resolve(item)
    }

    // 队列为空，注册 waiter 等待下一个 push
    return new Promise<StreamQueueItem>(resolve => {
      stream.waiter = (item) => {
        // 消费后检查背压
        if (this.stdinPaused && this.shouldResume()) {
          this.resumeStdin()
        }
        resolve(item)
      }
    })
  }

  // ─── 私有方法：背压控制 ──────────────────────────────────────────────────────

  /**
   * 暂停 stdin 读取（防止事件队列无限增长）。
   */
  private pauseStdin(): void {
    if (!this.stdinPaused) {
      this.stdinPaused = true
      // Node.js ReadableStream 的 pause() 方法
      if (typeof (this.stdin as NodeJS.ReadableStream & { pause?: () => void }).pause === 'function') {
        (this.stdin as NodeJS.ReadableStream & { pause: () => void }).pause()
      }
    }
  }

  /**
   * 恢复 stdin 读取。
   */
  private resumeStdin(): void {
    if (this.stdinPaused) {
      this.stdinPaused = false
      if (typeof (this.stdin as NodeJS.ReadableStream & { resume?: () => void }).resume === 'function') {
        (this.stdin as NodeJS.ReadableStream & { resume: () => void }).resume()
      }
    }
  }

  /**
   * 判断是否应该恢复 stdin（所有活跃流的队列都低于恢复阈值）。
   *
   * 恢复阈值 = maxQueueSize / 2（防止 hysteresis 抖动）。
   */
  private shouldResume(): boolean {
    const resumeThreshold = Math.floor(this.maxQueueSize / 2)
    for (const [, stream] of this.activeStreams) {
      if (stream.queue.length > resumeThreshold) {
        return false
      }
    }
    return true
  }

  // ─── 私有方法：断言 ──────────────────────────────────────────────────────────

  /**
   * 断言 Transport 已就绪，否则抛出错误。
   */
  private assertReady(): void {
    if (!this.ready) {
      throw new Error('JsonRpcTransport 尚未初始化，请先调用 initialize()')
    }
  }
}
