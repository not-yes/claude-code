/**
 * core/StateManager.ts
 *
 * 可注入的状态管理，替代 bootstrap/state.ts 中的 React 绑定。
 *
 * 设计原则：
 * 1. 纯 TypeScript 实现，不依赖 React/Ink/useState
 * 2. 观察者模式（Observer Pattern）替代 React 的 setState 触发重渲染
 * 3. 同时管理两层状态：
 *    - CoreState：Sidecar 对外暴露的精简状态（不含 UI 字段）
 *    - AppState 适配器：通过 buildAppStateAccessor() 为现有 QueryEngine 提供兼容接口
 * 4. 线程安全：所有状态更新是同步的（Node.js 单线程，无需锁）
 *
 * 与现有代码的关系：
 *   - CoreState 是 AppState（src/state/AppStateStore.ts）的子集投影
 *   - getAppState/setAppState 回调对应 QueryEngine.config 中的同名字段
 *   - bootstrap/state.ts 中的全局 STATE 对象替代方案
 *   - 不使用 src/state/store.ts 中的 createStore()（因其依赖 React）
 */

import type { AgentCoreConfig, CorePermissionMode, CoreState } from './types.js'

// ─── CoreState 默认值 ──────────────────────────────────────────────────────────

function getDefaultCoreState(config: AgentCoreConfig): CoreState {
  return {
    cwd: config.cwd,
    sessionId: generateSessionId(),
    permissionMode: config.defaultPermissionMode ?? 'interactive',
    alwaysAllowRules: [],
    alwaysDenyRules: [],
    totalCostUsd: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  }
}

function generateSessionId(): string {
  // 使用 crypto.randomUUID()（Node.js 15.6+ 内置）
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomUUID } = require('crypto') as typeof import('crypto')
    return randomUUID()
  } catch {
    // 降级方案（极少数情况）
    return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

// ─── AppState 适配器类型 ───────────────────────────────────────────────────────

/**
 * AppState 是现有 QueryEngine 期望的完整状态对象（含大量 UI 字段）。
 * 此处使用 unknown 类型避免循环导入，运行时通过动态加载获取实际类型。
 *
 * 参考 src/state/AppStateStore.ts 中的 AppState 类型定义。
 */
type AppStateAny = Record<string, unknown>

// ─── StateManager 类 ──────────────────────────────────────────────────────────

/**
 * 可注入的状态管理器。
 *
 * 职责：
 * 1. 维护 CoreState（Sidecar 对外状态）
 * 2. 维护 AppState 适配层（供 QueryEngine 调用，保持兼容）
 * 3. 通知已注册的观察者（替代 React 的重渲染机制）
 * 4. 管理 FileStateCache（文件内容缓存，供 QueryEngine 使用）
 *
 * 关键设计：
 * - CoreState 是精简视图，与 AppState 保持双向同步
 * - AppState 通过 buildAppStateAccessor() 提供，内部通过 CoreState 派生
 * - 避免存储整个 AppState 对象（减少内存占用，消除 UI 字段依赖）
 */
export class StateManager {
  /** 核心状态（精简，不含 UI） */
  private coreState: CoreState
  /** 观察者列表 */
  private observers: Set<(state: CoreState) => void>
  /** 完整 AppState 适配层（懒加载，供 QueryEngine 使用） */
  private appStateAdapter: AppStateAny | null = null
  /** FileStateCache（供 QueryEngine 复用，跨 execute 调用持久化） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private fileStateCache: any = null

  constructor(config: AgentCoreConfig) {
    this.coreState = getDefaultCoreState(config)
    this.observers = new Set()
    this.initFileStateCache()
  }

  // ─── CoreState 管理 ────────────────────────────────────────────────────

  /**
   * 获取当前 CoreState 快照。
   * 返回的是引用，调用方不应修改返回值（TypeScript 类型系统约束）。
   */
  getState(): CoreState {
    return this.coreState
  }

  /**
   * 更新 CoreState，触发所有观察者。
   *
   * 替代现有代码中的 setAppState（React useState 的 dispatch 函数）。
   * 使用函数式更新模式（updater 接收旧状态，返回新状态）保证原子性。
   *
   * 对应现有代码：
   *   QueryEngine.config.setAppState = (f) => { dispatch(f) }  // React 版本
   *   此处 = (f) => { this.coreState = f(this.coreState); this.notify() }
   */
  setState(updater: (prev: CoreState) => CoreState): void {
    const newState = updater(this.coreState)
    if (newState === this.coreState) return  // 短路：状态未变化

    this.coreState = newState
    // 同步更新 AppState 适配层中的相关字段
    this.syncToAppState(newState)
    // 通知所有观察者
    this.notify()
  }

  /**
   * 订阅状态变更。
   *
   * 替代 React 中的 useEffect + 状态依赖，
   * 或 src/state/store.ts 中的 store.subscribe()。
   *
   * @returns 取消订阅函数（调用即停止监听）
   */
  subscribe(observer: (state: CoreState) => void): () => void {
    this.observers.add(observer)
    return () => {
      this.observers.delete(observer)
    }
  }

  // ─── AppState 适配层 ───────────────────────────────────────────────────

  /**
   * 构建 QueryEngine 所需的 getAppState/setAppState 访问器对。
   *
   * 这是关键的解耦点：QueryEngine 内部通过这两个函数读写 AppState，
   * 我们在这里将其桥接到 CoreState，消除对 React useState 的依赖。
   *
   * 对应现有代码：
   *   在 REPL 中：由 AppStateProvider + React useState 提供
   *   在 SDK/print 模式中：由 ask.ts 中简单的对象变量提供
   *   此处：由 StateManager 管理的 AppState 适配层提供
   */
  buildAppStateAccessor(): {
    getAppState: () => AppStateAny
    setAppState: (f: (prev: AppStateAny) => AppStateAny) => void
  } {
    // 确保 AppState 适配层已初始化
    this.ensureAppState()

    return {
      getAppState: () => this.appStateAdapter!,
      setAppState: (f) => {
        if (!this.appStateAdapter) return
        const newAppState = f(this.appStateAdapter)
        if (newAppState === this.appStateAdapter) return

        this.appStateAdapter = newAppState
        // 将 AppState 中的关键字段同步回 CoreState
        this.syncFromAppState(newAppState)
      },
    }
  }

  // ─── FileStateCache 管理 ───────────────────────────────────────────────

  /**
   * 获取 FileStateCache（跨 execute 调用复用）。
   *
   * FileStateCache 是 LRU 缓存，存储已读取的文件内容（哈希+修改时间），
   * 避免重复读取相同文件。跨 turn 复用可以提高性能。
   *
   * 对应现有代码：
   *   src/utils/fileStateCache.ts 中的 FileStateCache 类型
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getFileStateCache(): any {
    return this.fileStateCache
  }

  // ─── 便捷状态更新方法 ──────────────────────────────────────────────────

  /**
   * 更新当前工作目录。
   * 对应 bootstrap/state.ts 中的 setCwdState()。
   */
  setCwd(cwd: string): void {
    this.setState(prev => prev.cwd === cwd ? prev : { ...prev, cwd })
  }

  /**
   * 更新权限模式。
   * 对应 ToolPermissionContext.mode 的修改。
   */
  setPermissionMode(mode: CorePermissionMode): void {
    this.setState(prev =>
      prev.permissionMode === mode ? prev : { ...prev, permissionMode: mode }
    )
  }

  /**
   * 追加 Token 使用量。
   * 对应 bootstrap/state.ts 中的 addToTotalCostState()。
   */
  addUsage(delta: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    costUsd?: number
  }): void {
    this.setState(prev => ({
      ...prev,
      totalCostUsd: prev.totalCostUsd + (delta.costUsd ?? 0),
      usage: {
        inputTokens: prev.usage.inputTokens + (delta.inputTokens ?? 0),
        outputTokens: prev.usage.outputTokens + (delta.outputTokens ?? 0),
        cacheReadTokens: prev.usage.cacheReadTokens + (delta.cacheReadTokens ?? 0),
        cacheCreationTokens:
          prev.usage.cacheCreationTokens + (delta.cacheCreationTokens ?? 0),
      },
    }))
  }

  /**
   * 重置会话（清空消息历史和统计数据）。
   * 对应 /clear 命令 + regenerateSessionId() 的组合效果。
   */
  resetSession(): void {
    this.setState(prev => ({
      ...prev,
      sessionId: generateSessionId(),
      totalCostUsd: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    }))
  }

  // ─── 私有辅助方法 ─────────────────────────────────────────────────────

  /**
   * 通知所有观察者状态已变更。
   */
  private notify(): void {
    for (const observer of this.observers) {
      try {
        observer(this.coreState)
      } catch (err) {
        // 观察者错误不应影响状态更新本身
        console.error('[StateManager] 观察者回调出错:', err)
      }
    }
  }

  /**
   * 初始化 FileStateCache。
   * 懒加载避免在 import 时触发文件系统操作。
   */
  private initFileStateCache(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createFileStateCacheWithSizeLimit } = require('../utils/fileStateCache.js') as
        typeof import('../utils/fileStateCache.js')
      // 创建空的 FileStateCache（默认限制：1000 条，100MB）
      this.fileStateCache = createFileStateCacheWithSizeLimit(1000, 100 * 1024 * 1024)
    } catch {
      // 降级：创建最小化的 FileStateCache 兼容对象
      this.fileStateCache = {
        get: () => undefined,
        set: () => {},
        has: () => false,
        delete: () => false,
        clear: () => {},
        max: 1000,
        maxSize: 0,
      }
    }
  }

  /**
   * 确保 AppState 适配层已初始化。
   * 懒加载避免在构造时触发 AppStateStore 的副作用。
   */
  private ensureAppState(): void {
    if (this.appStateAdapter !== null) return

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getDefaultAppState } = require('../state/AppStateStore.js') as
        typeof import('../state/AppStateStore.js')

      const defaultAppState = getDefaultAppState()

      // 用 CoreState 覆盖关键字段
      this.appStateAdapter = this.mergeWithCoreState(defaultAppState, this.coreState)
    } catch {
      // 降级：创建最小化的 AppState（兼容 QueryEngine 的必要字段）
      this.appStateAdapter = this.buildMinimalAppState()
    }
  }

  /**
   * 将 CoreState 同步到 AppState 适配层。
   * 在 CoreState 更新后调用，保持两层状态一致。
   */
  private syncToAppState(coreState: CoreState): void {
    if (!this.appStateAdapter) return

    // 更新 toolPermissionContext.mode
    const currentCtx = this.appStateAdapter.toolPermissionContext as AppStateAny
    if (currentCtx && typeof currentCtx === 'object') {
      const internalMode = this.toInternalMode(coreState.permissionMode)
      if (currentCtx.mode !== internalMode) {
        this.appStateAdapter = {
          ...this.appStateAdapter,
          toolPermissionContext: {
            ...currentCtx,
            mode: internalMode,
          },
        }
      }
    }
  }

  /**
   * 将 AppState 中的关键字段同步回 CoreState。
   * 在 QueryEngine 调用 setAppState 后触发，保持两层状态一致。
   */
  private syncFromAppState(appState: AppStateAny): void {
    const toolPermCtx = appState.toolPermissionContext as AppStateAny | undefined
    if (!toolPermCtx) return

    const internalMode = toolPermCtx.mode as string | undefined
    if (!internalMode) return

    const coreMode = this.fromInternalMode(internalMode)
    if (coreMode !== this.coreState.permissionMode) {
      // 直接更新 coreState（不通过 setState 避免无限循环）
      this.coreState = { ...this.coreState, permissionMode: coreMode }
      this.notify()
    }
  }

  /**
   * 将 CoreState 中的权限模式映射到 AppState 内部使用的 PermissionMode 字符串。
   */
  private toInternalMode(mode: CorePermissionMode): string {
    const mapping: Record<CorePermissionMode, string> = {
      'interactive': 'default',
      'auto-approve': 'acceptEdits',
      'plan-only': 'plan',
      'deny-all': 'dontAsk',
    }
    return mapping[mode]
  }

  /**
   * 将 AppState 内部 PermissionMode 字符串映射回 CorePermissionMode。
   */
  private fromInternalMode(internalMode: string): CorePermissionMode {
    const mapping: Record<string, CorePermissionMode> = {
      'default': 'interactive',
      'acceptEdits': 'auto-approve',
      'bypassPermissions': 'auto-approve',
      'dontAsk': 'deny-all',
      'plan': 'plan-only',
      'auto': 'auto-approve',
    }
    return mapping[internalMode] ?? 'interactive'
  }

  /**
   * 将 AppState 与 CoreState 合并，CoreState 的值优先。
   */
  private mergeWithCoreState(
    appState: Record<string, unknown>,
    coreState: CoreState,
  ): AppStateAny {
    const toolPermCtx = appState.toolPermissionContext as Record<string, unknown> | undefined

    return {
      ...appState,
      toolPermissionContext: {
        ...(toolPermCtx ?? {}),
        mode: this.toInternalMode(coreState.permissionMode),
      },
    }
  }

  /**
   * 构建最小化 AppState（当 getDefaultAppState 加载失败时的降级方案）。
   *
   * 包含 QueryEngine 必需的最小字段集：
   *   - toolPermissionContext（权限上下文）
   *   - mcp（MCP 服务器状态）
   *   - 其他通用字段
   *
   * 参考 src/state/AppStateStore.ts 中的 getDefaultAppState()。
   */
  private buildMinimalAppState(): AppStateAny {
    return {
      // 权限上下文（QueryEngine 在 query.ts 中访问）
      toolPermissionContext: {
        mode: this.toInternalMode(this.coreState.permissionMode),
        additionalWorkingDirectories: new Map(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: false,
        isAutoModeAvailable: false,
        shouldAvoidPermissionPrompts: false,
        awaitAutomatedChecksBeforeDialog: false,
      },
      // MCP 状态（QueryEngine 在 query.ts 第 689 行访问）
      mcp: {
        clients: [],
        tools: [],
        commands: [],
        resources: {},
        pluginReconnectKey: 0,
      },
      // 其他 QueryEngine 访问的字段
      verbose: false,
      mainLoopModel: null,
      mainLoopModelForSession: null,
      settings: {},
      tasks: {},
      agentNameRegistry: new Map(),
      plugins: {
        enabled: [],
        disabled: [],
        commands: [],
        errors: [],
        installationStatus: { marketplaces: [], channels: [] },
      },
      fileHistory: { enabled: false, snapshots: new Map() },
      attribution: { commits: [], isTracking: false },
      effortValue: undefined,
      advisorModel: undefined,
      fastMode: undefined,
      // QueryEngine 运行时访问的必要字段
      sessionId: this.coreState.sessionId,
      modelUsage: {},
      getTotalCost: () => this.coreState.totalCostUsd ?? 0,
      getInMemoryErrors: () => [],
    }
  }
}
