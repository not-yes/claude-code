/**
 * sidecar/streamHandler.ts
 *
 * 流式事件处理模块：将 AgentCore.execute() 返回的 AsyncGenerator<SidecarStreamEvent>
 * 转换为 JSON-RPC notifications 并发送到 stdout。
 *
 * 消息协议：
 * - 每个事件发送 `$/stream` notification：{ method: "$/stream", params: { executeId, event } }
 * - 流结束发送 `$/complete`：{ method: "$/complete", params: { executeId } }
 * - 流出错发送 `$/streamError`：{ method: "$/streamError", params: { executeId, message, code? } }
 *
 * 背压控制：
 * - 使用 drain 事件和 write 回调检测 stdout 背压
 * - 当 stdout 缓冲区满时暂停 generator 消费（通过 await 的形式天然实现）
 *
 * 无 React/Ink 依赖，纯 Node.js 流处理逻辑。
 */

import type { SidecarStreamEvent } from '../core/types'
import type { AgentCore } from '../core/AgentCore'

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

/**
 * JSON-RPC 2.0 Notification（无 id 字段，不需要响应）
 */
interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

/**
 * StreamHandler 的配置选项
 */
export interface StreamHandlerOptions {
  /**
   * stdout 高水位线（字节数）。
   * 当 process.stdout 写入缓冲积累超过此值时，等待 drain 事件。
   * 默认：64KB
   */
  highWaterMark?: number

  /**
   * 是否在控制台打印调试日志（发到 stderr，不影响 stdout 协议）
   */
  debug?: boolean
}

/**
 * 流式执行的结果摘要（供 JsonRpcServer 使用）
 */
export interface StreamResult {
  /** 正常完成还是出错 */
  success: boolean
  /** 如果出错，错误消息 */
  errorMessage?: string
  /** 如果出错，错误码 */
  errorCode?: string
  /** 消费的事件总数 */
  eventCount: number
}

// ─── StreamHandler 类 ─────────────────────────────────────────────────────────

/**
 * StreamHandler 管理单次 execute() 调用的流式转发生命周期。
 *
 * 每次 RPC `execute` 调用创建一个独立的 StreamHandler 实例，
 * 负责将 AgentCore 的事件流转为 NDJSON 格式发往 stdout。
 */
export class StreamHandler {
  private writeLine: (line: string) => Promise<void>
  private options: Required<StreamHandlerOptions>

  /** 流是否已正常完成（防止重复清理） */
  private isCompleted = false
  /** 流是否已被中止（防止重复中止） */
  private isAborted = false

  /**
   * 最近一次收到流事件的时间戳（毫秒）。
   * 由 JsonRpcServer 读取，用于空闲超时检测。
   * 在 handle() 开始前由外部初始化为 Date.now()。
   */
  public lastActivityTime: number = Date.now()

  /**
   * @param writeLine 向 stdout 写入一行（带背压等待）的异步函数
   * @param options 配置选项
   */
  constructor(
    writeLine: (line: string) => Promise<void>,
    options: StreamHandlerOptions = {},
  ) {
    this.writeLine = writeLine
    this.options = {
      highWaterMark: options.highWaterMark ?? 65536, // 64KB
      debug: options.debug ?? false,
    }
  }

  // ─── 公共方法 ──────────────────────────────────────────────────────────────

  /**
   * 消费 AgentCore 的事件流，将每个事件转为 JSON-RPC notification 发送。
   *
   * 此方法会 await 直到流完全结束（正常完成或出错）。
   *
   * @param executeId 执行 ID（由 JsonRpcServer 生成，用于关联响应和流事件）
   * @param generator AgentCore.execute() 返回的异步生成器
   * @returns 流执行结果摘要
   */
  async handle(
    executeId: string,
    generator: AsyncGenerator<SidecarStreamEvent>,
  ): Promise<StreamResult> {
    let eventCount = 0
    let hasReceivedFirstEvent = false

    process.stderr.write(`[StreamHandler] 开始处理 executeId=${executeId}\n`)

    // 流启动超时检测：10 秒内未收到任何事件则发送超时错误通知
    let startTimeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(async () => {
      if (!hasReceivedFirstEvent) {
        process.stderr.write(`[StreamHandler] [${executeId}] 流启动超时（10秒内未收到任何事件）\n`)
        this.debugLog(`[${executeId}] 流启动超时，10 秒内未收到任何事件`)
        try {
          await this.sendStreamErrorNotification(
            executeId,
            'Stream start timeout: no events received within 10 seconds',
            'STREAM_START_TIMEOUT',
          )
        } catch {
          // stdout 写入失败，忽略
        }
      }
    }, 10_000)

    try {
      for await (const event of generator) {
        // 收到第一条事件，清除超时计时器
        if (!hasReceivedFirstEvent) {
          hasReceivedFirstEvent = true
          if (startTimeoutHandle !== null) {
            clearTimeout(startTimeoutHandle)
            startTimeoutHandle = null
          }
          process.stderr.write(`[StreamHandler] [${executeId}] 收到第一个事件 type=${event.type}\n`)
        }

        // 更新最近活动时间（供外部空闲超时检测使用）
        this.lastActivityTime = Date.now()

        eventCount++
        this.debugLog(`[${executeId}] 事件 #${eventCount}:`, event.type)

        // 前5个事件和每100个事件打印计数日志
        if (eventCount <= 5 || eventCount % 100 === 0) {
          process.stderr.write(`[StreamHandler] executeId=${executeId} 收到第 ${eventCount} 个事件 type=${event.type}\n`)
        }

        // 每 50 个事件检查一次 listener 数量
        if (eventCount % 50 === 0 && eventCount > 0) {
          const drainListeners = process.stdout.listenerCount('drain')
          const errorListeners = process.stdout.listenerCount('error')
          if (drainListeners > 3 || errorListeners > 3) {
            process.stderr.write(
              `[StreamHandler] [${executeId}] listener 警告: drain=${drainListeners}, error=${errorListeners}, events=${eventCount}\n`
            )
          }
        }

        // 发送 `$/stream` notification（天然背压：await writeLine 等待 stdout drain）
        await this.sendStreamNotification(executeId, event)

        // 如果收到 complete 或 error 事件，流已结束（generator 内部也会 return）
        // 但为了安全起见，让 generator 自然结束，不在这里 break
      }

      // 流正常完成，标记状态
      this.isCompleted = true

      // 发送 `$/complete` notification
      await this.sendCompleteNotification(executeId)
      process.stderr.write(`[StreamHandler] [${executeId}] 流正常完成，共 ${eventCount} 个事件\n`)
      this.debugLog(`[${executeId}] 流完成，共 ${eventCount} 个事件`)

      return { success: true, eventCount }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code =
        err instanceof Error && 'code' in err
          ? String((err as NodeJS.ErrnoException).code)
          : undefined

      process.stderr.write(`[StreamHandler] [${executeId}] 流出错: ${message} code=${code}\n`)
      this.debugLog(`[${executeId}] 流出错:`, message)

      // 发送 `$/streamError` notification
      try {
        await this.sendStreamErrorNotification(executeId, message, code)
      } catch (writeErr) {
        // stdout 写入失败（进程可能正在关闭），不再抛出
        this.debugLog(`[${executeId}] 发送错误通知失败:`, writeErr)
      }

      return { success: false, errorMessage: message, errorCode: code, eventCount }
    } finally {
      // 确保超时计时器在流结束时总是被清除
      if (startTimeoutHandle !== null) {
        clearTimeout(startTimeoutHandle)
      }
    }
  }

  /**
   * 中止正在进行的流（通过调用 generator.return()）。
   *
   * @param executeId 执行 ID（用于日志）
   * @param generator 需要中止的生成器
   */
  async abort(
    executeId: string,
    generator: AsyncGenerator<SidecarStreamEvent>,
  ): Promise<void> {
    // 防止双重中止或在已完成的流上执行 abort
    if (this.isCompleted || this.isAborted) {
      this.debugLog(`[${executeId}] abort 被跳过（isCompleted=${this.isCompleted}, isAborted=${this.isAborted}）`)
      return
    }
    this.isAborted = true

    try {
      await generator.return(undefined)
      this.debugLog(`[${executeId}] 流已主动中止`)
    } catch {
      // 中止时生成器可能已经结束，忽略错误
    }
  }

  // ─── 私有方法 ──────────────────────────────────────────────────────────────

  /**
   * 发送 `$/stream` notification（单个流事件）
   */
  private async sendStreamNotification(
    executeId: string,
    event: SidecarStreamEvent,
  ): Promise<void> {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: '$/stream',
      params: {
        executeId,
        event,
      },
    }
    await this.writeLine(JSON.stringify(notification))
  }

  /**
   * 发送 `$/complete` notification（流正常结束）
   */
  private async sendCompleteNotification(executeId: string): Promise<void> {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: '$/complete',
      params: {
        executeId,
      },
    }
    await this.writeLine(JSON.stringify(notification))
  }

  /**
   * 发送 `$/streamError` notification（流出错结束）
   */
  private async sendStreamErrorNotification(
    executeId: string,
    message: string,
    code?: string,
  ): Promise<void> {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: '$/streamError',
      params: {
        executeId,
        message,
        ...(code !== undefined && { code }),
      },
    }
    await this.writeLine(JSON.stringify(notification))
  }

  /**
   * 输出调试日志到 stderr（不污染 stdout 协议）
   */
  private debugLog(...args: unknown[]): void {
    if (this.options.debug) {
      process.stderr.write(`[StreamHandler] ${args.join(' ')}\n`)
    }
  }
}

// ─── 工厂函数：创建带背压控制的 writeLine ──────────────────────────────────────

/**
 * 创建支持背压控制的异步 writeLine 函数。
 *
 * Node.js Writable stream（process.stdout）的 write() 方法返回 boolean：
 * - true：缓冲区未满，可以继续写入
 * - false：缓冲区已满，应等待 'drain' 事件
 *
 * 此函数封装了这个背压控制逻辑，使 StreamHandler 可以用 await 自然暂停。
 *
 * @param stream 目标可写流（默认 process.stdout）
 * @returns 异步写入函数
 */
export function createBackpressureWriter(
  stream: NodeJS.WritableStream = process.stdout,
  drainTimeoutMs: number = 30_000,
): (line: string) => Promise<void> {
  return (line: string): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      // 写入 NDJSON 行（末尾加换行符）
      const canContinue = stream.write(line + '\n', 'utf8', err => {
        if (err) {
          reject(err)
        }
      })

      if (canContinue) {
        // 缓冲区未满，立即 resolve
        resolve()
      } else {
        // 缓冲区已满，等待 drain 事件（背压控制）
        let cleaned = false
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null

        const cleanup = () => {
          if (cleaned) return
          cleaned = true
          if (timeoutHandle !== null) clearTimeout(timeoutHandle)
          stream.removeListener('drain', onDrain)
          stream.removeListener('error', onError)
        }

        const onDrain = () => {
          cleanup()
          resolve()
        }

        const onError = (err: Error) => {
          cleanup()
          reject(err)
        }

        stream.once('drain', onDrain)
        stream.once('error', onError)

        // Drain 超时保护：防止永久等待
        timeoutHandle = setTimeout(() => {
          cleanup()
          process.stderr.write(`[WARN] stdout drain timeout after ${drainTimeoutMs}ms, forcing continue\n`)
          resolve() // 强制继续，不破坏流
        }, drainTimeoutMs)
      }
    })
  }
}

/**
 * 创建用于 PermissionBridge 的同步 writeLine（不需要背压控制）。
 *
 * 权限请求消息通常很小（远小于 highWaterMark），
 * 同步写入风险极低，简化实现。
 *
 * @param stream 目标可写流（默认 process.stdout）
 */
export function createSyncWriter(
  stream: NodeJS.WritableStream = process.stdout,
): (line: string) => void {
  return (line: string): void => {
    stream.write(line + '\n', 'utf8')
  }
}

// ─── 活跃流注册表 ─────────────────────────────────────────────────────────────

/**
 * ActiveStreamRegistry 跟踪当前所有活跃的流执行。
 *
 * 用于：
 * 1. abort RPC 方法：根据 executeId 找到对应 generator 并中止
 * 2. 关闭时中止所有活跃流
 */
export class ActiveStreamRegistry {
  private streams = new Map<
    string,
    {
      generator: AsyncGenerator<SidecarStreamEvent>
      handler: StreamHandler
      agentCore: AgentCore
    }
  >()

  /**
   * 注册一个活跃流
   */
  register(
    executeId: string,
    generator: AsyncGenerator<SidecarStreamEvent>,
    handler: StreamHandler,
    agentCore: AgentCore,
  ): void {
    this.streams.set(executeId, { generator, handler, agentCore })
  }

  /**
   * 注销一个流（流结束后调用）
   */
  unregister(executeId: string): void {
    this.streams.delete(executeId)
  }

  /**
   * 中止指定 executeId 的流
   *
   * @returns 是否找到并中止了流
   */
  async abort(executeId: string): Promise<boolean> {
    const entry = this.streams.get(executeId)
    if (!entry) return false

    // 中止 AgentCore 的执行
    entry.agentCore.abort()

    // 中止 generator
    await entry.handler.abort(executeId, entry.generator)

    this.streams.delete(executeId)
    return true
  }

  /**
   * 中止所有活跃流（关闭时调用）
   */
  async abortAll(reason = '服务关闭'): Promise<void> {
    const ids = [...this.streams.keys()]
    await Promise.allSettled(ids.map(id => this.abort(id)))
    void reason // 仅用于日志，当前简化实现忽略
  }

  /**
   * 当前活跃流数量
   */
  get count(): number {
    return this.streams.size
  }
}
