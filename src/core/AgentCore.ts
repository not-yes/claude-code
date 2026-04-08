/**
 * core/AgentCore.ts
 *
 * AgentCore 核心接口定义与工厂函数。
 *
 * 设计原则：
 * 1. AgentCore 接口是 Sidecar 和 CLI 两种模式的统一抽象层
 * 2. 不直接导入 React/Ink/readline，所有 UI 回调通过依赖注入
 * 3. 包装现有 QueryEngine 类，通过适配器模式复用现有逻辑
 * 4. 权限处理通过 onPermissionRequest 回调注入，而非 React hooks
 *
 * 与现有代码的关系：
 *   - 包装 src/QueryEngine.ts 中的 QueryEngine 类
 *   - canUseTool 回调对应 src/hooks/useCanUseTool.ts 中的 CanUseToolFn
 *   - getAppState/setAppState 由 StateManager 提供，替代 React useState
 */

import type {
  AgentCoreConfig,
  CorePermissionMode,
  CoreState,
  ExecuteOptions,
  PermissionDecision,
  PermissionRequest,
  SidecarStreamEvent,
  Session,
  SessionParams,
  ToolInfo,
} from './types.js'
import type { StateManager } from './StateManager.js'
import type { ToolRegistry } from './ToolRegistry.js'
import type { PermissionEngine } from './PermissionEngine.js'
import type { SessionStorage } from '../sidecar/storage/sessionStorage.js'

// ─── AgentCore 接口 ────────────────────────────────────────────────────────────

/**
 * AgentCore 是 Sidecar 模式的核心接口。
 * CLI 渲染层（Ink/React）和 Sidecar HTTP 服务都通过此接口与 Agent 逻辑交互。
 *
 * 典型使用方式：
 * ```typescript
 * const agent = await createAgentCore({ cwd: process.cwd() });
 * await agent.initialize();
 *
 * for await (const event of agent.execute('请帮我分析这个代码库')) {
 *   if (event.type === 'text') console.log(event.content);
 *   if (event.type === 'complete') break;
 * }
 * ```
 */
export interface AgentCore {
  // ─── 核心执行 ────────────────────────────────────────────────────────────

  /**
   * 执行一次查询，以 AsyncGenerator 形式流式返回事件。
   *
   * 对应现有代码：
   *   QueryEngine.submitMessage() 返回 AsyncGenerator<SDKMessage>，
   *   此处将其适配为 SidecarStreamEvent 序列。
   *
   * @param content 用户输入内容
   * @param options 执行选项（模型、权限模式等）
   */
  execute(
    content: string,
    options?: ExecuteOptions,
  ): AsyncGenerator<SidecarStreamEvent>

  /**
   * 中断当前正在执行的查询。
   * 对应现有代码中 AbortController.abort() 的调用。
   */
  abort(): void

  // ─── 会话管理 ────────────────────────────────────────────────────────────

  /**
   * 创建新会话。
   * 对应现有代码：bootstrap/state.ts 中的 regenerateSessionId()
   */
  createSession(params?: SessionParams): Promise<Session>

  /**
   * 按 ID 获取已有会话。
   * 对应现有代码：utils/sessionStorage.ts 中的会话读取逻辑。
   */
  getSession(id: string): Promise<Session | null>

  /**
   * 列出所有已保存的会话。
   */
  listSessions(): Promise<Session[]>

  /**
   * 清空当前会话的消息历史（不删除会话元数据）。
   * 对应 REPL 中的 /clear 命令。
   */
  clearSession(): Promise<void>

  // ─── 工具管理 ────────────────────────────────────────────────────────────

  /**
   * 列出当前可用的所有工具。
   * 对应 getTools() 返回的工具列表，过滤为 ToolInfo 简化视图。
   */
  listTools(): ToolInfo[]

  /**
   * 检查特定工具是否启用。
   */
  isToolEnabled(toolName: string): boolean

  // ─── 权限回调（依赖注入） ─────────────────────────────────────────────────

  /**
   * 权限请求回调（由调用方注入）。
   *
   * 当 permissionMode='interactive' 且遇到需要用户确认的操作时调用。
   * Sidecar 模式：通过 WebSocket 发送 permission_request 事件，等待前端响应。
   * CLI 模式：通过 Ink UI 显示对话框，等待用户键盘输入。
   *
   * 对应现有代码：
   *   src/hooks/useCanUseTool.tsx 中通过 React context 传递的权限处理器，
   *   此处改为通过回调注入，消除 React 依赖。
   */
  onPermissionRequest?: (
    request: PermissionRequest,
  ) => Promise<PermissionDecision>

  // ─── 状态访问 ────────────────────────────────────────────────────────────

  /**
   * 获取当前核心状态快照（不含 UI 状态）。
   */
  getState(): CoreState

  /**
   * 订阅核心状态变更。
   * 返回取消订阅函数。
   */
  onStateChange(listener: (state: CoreState) => void): () => void

  // ─── 生命周期 ────────────────────────────────────────────────────────────

  /**
   * 初始化 AgentCore（加载配置、连接 MCP 服务器等）。
   * 必须在首次 execute() 前调用。
   */
  initialize(): Promise<void>

  /**
   * 优雅关闭（清理资源、断开 MCP 连接等）。
   */
  shutdown(): Promise<void>
}

// ─── 内部依赖接口 ──────────────────────────────────────────────────────────────

/**
 * AgentCore 工厂函数所需的内部依赖。
 * 通过依赖注入允许在测试中替换。
 */
export interface AgentCoreDeps {
  stateManager: StateManager
  toolRegistry: ToolRegistry
  permissionEngine: PermissionEngine
}

// ─── 权限模式映射 ──────────────────────────────────────────────────────────────

/**
 * 将 CorePermissionMode 映射到内部 PermissionMode 字符串。
 * 对应 src/utils/permissions/PermissionMode.ts 中的 PermissionMode 类型。
 *
 * 内部 PermissionMode 的完整列表：
 *   'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'auto' | 'bubble'
 */
export function toInternalPermissionMode(
  mode: CorePermissionMode,
): string {
  const mapping: Record<CorePermissionMode, string> = {
    'interactive': 'default',
    'auto-approve': 'acceptEdits',
    'plan-only': 'plan',
    'deny-all': 'dontAsk',
  }
  return mapping[mode]
}

/**
 * 将内部 PermissionMode 字符串映射回 CorePermissionMode。
 */
export function toCorePermissionMode(
  internalMode: string,
): CorePermissionMode {
  const mapping: Record<string, CorePermissionMode> = {
    'default': 'interactive',
    'acceptEdits': 'auto-approve',
    'bypassPermissions': 'auto-approve',
    'dontAsk': 'deny-all',
    'plan': 'plan-only',
    'auto': 'auto-approve',
    'bubble': 'interactive',
  }
  return mapping[internalMode] ?? 'interactive'
}

// ─── AgentCore 实现类 ──────────────────────────────────────────────────────────

/**
 * AgentCoreImpl 是 AgentCore 接口的具体实现。
 * 包装现有 QueryEngine，通过适配器模式复用核心逻辑。
 *
 * 关键设计决策：
 * 1. QueryEngine 按需懒加载（require），避免循环依赖和模块副作用
 * 2. onPermissionRequest 回调替代 React hooks 进行权限检查
 * 3. StateManager 替代 React useState/useReducer 管理状态
 */
class AgentCoreImpl implements AgentCore {
  private config: AgentCoreConfig
  private deps: AgentCoreDeps
  private abortController: AbortController | null = null
  private isInitialized = false
  // 可选的会话持久化层（由 entry.ts 注入）
  private sessionStorage: SessionStorage | null = null
  // 当前活跃会话 ID（用于消息追加）
  private activeSessionId: string | null = null

  // 懒加载 QueryEngine 模块（避免在 import 时触发 React/Ink 副作用）
  private queryEngineModule: typeof import('../QueryEngine.js') | null = null

  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>

  constructor(config: AgentCoreConfig, deps: AgentCoreDeps, sessionStorage?: SessionStorage) {
    this.config = config
    this.deps = deps
    this.sessionStorage = sessionStorage ?? null
  }

  // ─── 生命周期 ──────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.isInitialized) return

    // 懒加载 QueryEngine（该模块本身不依赖 React）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.queryEngineModule = require('../QueryEngine.js') as typeof import('../QueryEngine.js')

    // 初始化 StateManager 的工作目录
    const { cwd } = this.config
    this.deps.stateManager.setState(prev => ({
      ...prev,
      cwd,
      permissionMode: this.config.defaultPermissionMode ?? 'interactive',
    }))

    // 从 SessionStorage 加载已有会话（预热索引，失败不阻塞启动）
    if (this.sessionStorage) {
      try {
        await this.sessionStorage.listSessions()
      } catch {
        // 加载失败不阻塞初始化
      }
    }

    this.isInitialized = true
  }

  async shutdown(): Promise<void> {
    // 中断正在进行的查询
    this.abort()

    // 重置初始化标志
    this.isInitialized = false
    this.queryEngineModule = null
    this.activeSessionId = null
  }

  // ─── 核心执行 ──────────────────────────────────────────────────────────

  async *execute(
    content: string,
    options?: ExecuteOptions,
  ): AsyncGenerator<SidecarStreamEvent> {
    if (!this.isInitialized || !this.queryEngineModule) {
      throw new Error('AgentCore 尚未初始化，请先调用 initialize()')
    }

    // 创建新的 AbortController（每次执行独立）
    this.abortController = new AbortController()

    // 持久化用户输入消息
    if (this.sessionStorage && this.activeSessionId) {
      const userMsg = {
        role: 'user' as const,
        content,
        created_at: new Date().toISOString(),
      }
      await this.sessionStorage.appendMessage(this.activeSessionId, userMsg).catch(() => undefined)
    }

    const { QueryEngine } = this.queryEngineModule
    const stateManager = this.deps.stateManager
    const permissionEngine = this.deps.permissionEngine
    const toolRegistry = this.deps.toolRegistry

    // 构造 canUseTool 函数，将权限引擎和回调结合
    const canUseTool = this.buildCanUseToolFn(permissionEngine)

    // 构造传给 QueryEngine 的 AppState 访问器
    const { getAppState, setAppState } = stateManager.buildAppStateAccessor()

    try {
      // 获取工具列表（已筛选的）
      const tools = toolRegistry.getEnabledTools(options?.allowedTools)

      // 构造 QueryEngine 配置
      const engineConfig = {
        cwd: this.config.cwd,
        tools,
        commands: [],
        mcpClients: [],
        agents: [],
        canUseTool,
        getAppState,
        setAppState,
        readFileCache: stateManager.getFileStateCache(),
        customSystemPrompt: options?.systemPrompt,
        appendSystemPrompt: options?.appendSystemPrompt,
        userSpecifiedModel: options?.model,
        maxTurns: options?.maxTurns,
        maxBudgetUsd: this.config.maxBudgetUsd,
        verbose: false,
        abortController: this.abortController,
      }

      // 使用 QueryEngine 执行查询
      const engine = new QueryEngine(engineConfig)

      // 迭代 SDK 消息，转换为 SidecarStreamEvent
      let assistantTextBuffer = ''
      for await (const sdkMsg of engine.submitMessage(content, {
        uuid: options?.requestId,
      })) {
        const event = this.mapSDKMessageToStreamEvent(sdkMsg)
        if (event) {
          // 累积 assistant 文本用于持久化
          if (event.type === 'text' && !event.isThinking) {
            assistantTextBuffer += event.content
          }
          yield event
        }
      }
      // 持久化 assistant 回复（整轮合并为一条消息）
      if (this.sessionStorage && this.activeSessionId && assistantTextBuffer) {
        const assistantMsg = {
          role: 'assistant' as const,
          content: assistantTextBuffer,
          created_at: new Date().toISOString(),
        }
        await this.sessionStorage
          .appendMessage(this.activeSessionId, assistantMsg)
          .catch(() => undefined)
      }

      // 发出完成事件
      const currentState = stateManager.getState()
      yield {
        type: 'complete',
        reason: 'completed',
        usage: {
          inputTokens: currentState.usage.inputTokens,
          outputTokens: currentState.usage.outputTokens,
          cacheReadTokens: currentState.usage.cacheReadTokens,
          cacheCreationTokens: currentState.usage.cacheCreationTokens,
        },
      }
    } catch (error) {
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
    } finally {
      this.abortController = null
    }
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort('user_abort')
      this.abortController = null
    }
  }

  // ─── 会话管理 ──────────────────────────────────────────────────────────

  async createSession(params?: SessionParams): Promise<Session> {
    const { randomUUID } = await import('crypto')
    const id = randomUUID()
    const now = new Date().toISOString()

    // 更新工作目录（如果提供）
    if (params?.cwd) {
      this.deps.stateManager.setState(prev => ({
        ...prev,
        cwd: params.cwd!,
      }))
    }

    const session: Session = {
      id,
      createdAt: now,
      updatedAt: now,
      messages: [],
      metadata: {
        name: params?.name,
        model: params?.model,
        systemPrompt: params?.systemPrompt,
      },
    }

    // 设置为活跃会话
    this.activeSessionId = id

    // 持久化会话（失败不阻塞）
    if (this.sessionStorage) {
      await this.sessionStorage
        .saveSession(id, {
          metadata: {
            id,
            name: params?.name,
            model: params?.model,
            createdAt: now,
            updatedAt: now,
            messageCount: 0,
          },
          messages: [],
        })
        .catch(() => undefined)
    }

    return session
  }

  async getSession(id: string): Promise<Session | null> {
    // 优先从持久化层加载
    if (this.sessionStorage) {
      try {
        const data = await this.sessionStorage.loadSession(id)
        if (data) {
          return {
            id: data.metadata.id,
            createdAt: data.metadata.createdAt,
            updatedAt: data.metadata.updatedAt,
            messages: data.messages,
            metadata: {
              name: data.metadata.name,
              model: data.metadata.model,
            },
          }
        }
      } catch {
        // 持久化层读取失败，返回 null
      }
    }
    return null
  }

  async listSessions(): Promise<Session[]> {
    // 从持久化层读取会话索引
    if (this.sessionStorage) {
      try {
        const metadataList = await this.sessionStorage.listSessions()
        return metadataList.map(meta => ({
          id: meta.id,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          messages: [], // 列表接口不加载消息，保持轻量
          metadata: {
            name: meta.name,
            model: meta.model,
          },
        }))
      } catch {
        // 持久化层读取失败，返回空列表
      }
    }
    return []
  }

  async clearSession(): Promise<void> {
    // 清空 StateManager 中缓存的消息（QueryEngine 内部 mutableMessages 在下次 execute 重新创建）
    // 对应 REPL 中的 /clear 命令 → regenerateSessionId() + 清空消息数组
    const { randomUUID } = await import('crypto')
    this.deps.stateManager.setState(prev => ({
      ...prev,
      sessionId: randomUUID(),
    }))
    // 持久化层：删除当前活跃会话
    if (this.sessionStorage && this.activeSessionId) {
      await this.sessionStorage.deleteSession(this.activeSessionId).catch(() => undefined)
    }
    this.activeSessionId = null
  }

  // ─── 工具管理 ──────────────────────────────────────────────────────────

  listTools(): ToolInfo[] {
    return this.deps.toolRegistry.list().map(tool => ({
      name: tool.name,
      description: '',  // Tool.prompt() 是 async 的，此处返回空字符串
      isReadOnly: tool.isReadOnly({}),
      isMcp: tool.isMcp ?? false,
      mcpInfo: tool.mcpInfo,
    }))
  }

  isToolEnabled(toolName: string): boolean {
    return this.deps.toolRegistry.get(toolName) !== undefined
  }

  // ─── 状态访问 ──────────────────────────────────────────────────────────

  getState(): CoreState {
    return this.deps.stateManager.getState()
  }

  onStateChange(listener: (state: CoreState) => void): () => void {
    return this.deps.stateManager.subscribe(listener)
  }

  // ─── 私有辅助方法 ─────────────────────────────────────────────────────

  /**
   * 构造 canUseTool 函数。
   *
   * canUseTool 是现有代码中权限检查的核心接口（CanUseToolFn 类型）。
   * 此处将 PermissionEngine（纯逻辑规则匹配）和 onPermissionRequest 回调结合：
   *   1. 先用 PermissionEngine 检查是否有匹配的 alwaysAllow/alwaysDeny 规则
   *   2. 若无规则覆盖，根据权限模式决定：
   *      - 'auto-approve': 直接允许
   *      - 'interactive': 调用 onPermissionRequest 回调
   *      - 'deny-all': 直接拒绝
   *      - 'plan-only': 对写操作拒绝，读操作允许
   */
  private buildCanUseToolFn(permissionEngine: PermissionEngine) {
    // 返回符合 CanUseToolFn 签名的函数
    // 类型使用 any 避免循环引用（CanUseToolFn 引用了 Tool/ToolUseContext 等内部类型）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (tool: any, input: any, context: any): Promise<any> => {
      const toolName: string = tool.name
      const currentState = this.deps.stateManager.getState()
      const permMode = currentState.permissionMode

      // 1. 询问 PermissionEngine（基于规则的自动决策）
      const engineDecision = permissionEngine.evaluate(toolName, input)
      if (engineDecision !== null) {
        if (engineDecision.granted) {
          return { behavior: 'allow', updatedInput: input }
        } else {
          return {
            behavior: 'deny',
            message: engineDecision.denyReason ?? `工具 ${toolName} 被权限规则拒绝`,
          }
        }
      }

      // 2. 根据权限模式决定
      switch (permMode) {
        case 'auto-approve':
          return { behavior: 'allow', updatedInput: input }

        case 'deny-all':
          return {
            behavior: 'deny',
            message: `当前权限模式（deny-all）拒绝工具 ${toolName} 的执行`,
          }

        case 'plan-only': {
          // plan-only 模式：只读操作允许，写操作拒绝
          const isReadOp = tool.isReadOnly?.(input) ?? false
          if (isReadOp) {
            return { behavior: 'allow', updatedInput: input }
          }
          return {
            behavior: 'deny',
            message: `计划模式下不允许执行写操作（${toolName}）`,
          }
        }

        case 'interactive':
        default: {
          // 交互模式：调用 onPermissionRequest 回调
          if (!this.onPermissionRequest) {
            // 没有回调时，默认允许（与现有 bypassPermissions 行为对齐）
            return { behavior: 'allow', updatedInput: input }
          }

          // 构造权限请求
          const request: PermissionRequest = {
            requestId: `${toolName}-${Date.now()}`,
            tool: toolName,
            action: tool.userFacingName?.(input) ?? toolName,
            path: tool.getPath?.(input),
            description: `工具 ${toolName} 请求执行权限`,
            toolInput: typeof input === 'object' ? input : undefined,
          }

          try {
            const decision = await this.onPermissionRequest(request)
            if (decision.granted) {
              // 如果请求"记住"决策，通知 PermissionEngine 缓存
              if (decision.remember) {
                permissionEngine.remember(toolName, decision)
              }
              return { behavior: 'allow', updatedInput: input }
            } else {
              return {
                behavior: 'deny',
                message: decision.denyReason ?? `用户拒绝了 ${toolName} 的权限请求`,
              }
            }
          } catch {
            // 回调出错，保守拒绝
            return {
              behavior: 'deny',
              message: `权限请求处理失败，拒绝工具 ${toolName}`,
            }
          }
        }
      }
    }
  }

  /**
   * 将 QueryEngine 输出的 SDKMessage 映射到 SidecarStreamEvent。
   *
   * SDKMessage 类型定义在 src/entrypoints/agentSdkTypes.ts 中，
   * 包含 assistant、user、result、system 等消息类型。
   *
   * 返回 null 表示该消息不需要转发给 Sidecar 调用方。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapSDKMessageToStreamEvent(sdkMsg: any): SidecarStreamEvent | null {
    if (!sdkMsg || typeof sdkMsg !== 'object') return null

    const msgType = sdkMsg.type as string

    switch (msgType) {
      case 'assistant': {
        // 助手消息：提取 text 和 tool_use 块
        const content = sdkMsg.message?.content
        if (!Array.isArray(content)) return null

        // 只返回第一个事件（实际消费方会逐条处理）
        // 完整实现应逐块 yield，此处简化为返回第一个文本块
        for (const block of content) {
          if (block.type === 'text') {
            return { type: 'text', content: block.text ?? '' }
          }
          if (block.type === 'thinking') {
            return { type: 'text', content: block.thinking ?? '', isThinking: true }
          }
          if (block.type === 'tool_use') {
            return {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input ?? {},
            }
          }
        }
        return null
      }

      case 'user': {
        // 用户消息（通常是工具结果）
        const content = sdkMsg.message?.content
        if (!Array.isArray(content)) return null

        for (const block of content) {
          if (block.type === 'tool_result') {
            return {
              type: 'tool_result',
              id: block.tool_use_id,
              toolName: '',
              result: block.content,
              isError: block.is_error ?? false,
            }
          }
        }
        return null
      }

      case 'system': {
        // 系统消息（info/warning/error）
        return {
          type: 'system_message',
          level: (sdkMsg.level as 'info' | 'warning' | 'error') ?? 'info',
          content: sdkMsg.content ?? '',
        }
      }

      case 'result': {
        // SDK 结果消息（查询完成）
        return {
          type: 'complete',
          reason: sdkMsg.stop_reason ?? 'completed',
          usage: sdkMsg.usage
            ? {
                inputTokens: sdkMsg.usage.input_tokens ?? 0,
                outputTokens: sdkMsg.usage.output_tokens ?? 0,
                cacheReadTokens: sdkMsg.usage.cache_read_input_tokens ?? 0,
                cacheCreationTokens:
                  sdkMsg.usage.cache_creation_input_tokens ?? 0,
              }
            : undefined,
        }
      }

      default:
        // stream_request_start 等内部事件，不转发
        return null
    }
  }
}

// ─── 工厂函数 ──────────────────────────────────────────────────────────────────

/**
 * 创建 AgentCore 实例。
 *
 * 这是 Sidecar 模式的主要入口点。
 * 内部懒加载各子系统，避免在 import 时触发副作用。
 *
 * 使用示例：
 * ```typescript
 * import { createAgentCore } from './core/AgentCore.js';
 *
 * const agent = await createAgentCore({
 *   cwd: process.cwd(),
 *   defaultPermissionMode: 'interactive',
 * });
 *
 * // 注入权限回调（Sidecar 模式通过 WebSocket 传递给前端）
 * agent.onPermissionRequest = async (req) => {
 *   return sendToFrontend(req); // 返回 PermissionDecision
 * };
 *
 * await agent.initialize();
 * ```
 */
export async function createAgentCore(
  config: AgentCoreConfig,
  depsOverride?: Partial<AgentCoreDeps>,
  sessionStorage?: SessionStorage,
): Promise<AgentCore> {
  // 懒加载子系统，避免循环依赖
  const [
    { StateManager },
    { ToolRegistry },
    { PermissionEngine },
  ] = await Promise.all([
    import('./StateManager.js'),
    import('./ToolRegistry.js'),
    import('./PermissionEngine.js'),
  ])

  // 创建默认依赖（可被 depsOverride 覆盖，用于测试）
  const stateManager =
    depsOverride?.stateManager ?? new StateManager(config)
  const toolRegistry =
    depsOverride?.toolRegistry ?? new ToolRegistry()
  const permissionEngine =
    depsOverride?.permissionEngine ?? new PermissionEngine([])

  const deps: AgentCoreDeps = {
    stateManager,
    toolRegistry,
    permissionEngine,
  }

  return new AgentCoreImpl(config, deps, sessionStorage)
}
