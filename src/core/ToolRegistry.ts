/**
 * core/ToolRegistry.ts
 *
 * 工具注册/调度中心。
 *
 * 设计原则：
 * 1. 轻量封装，不改变现有 Tool 接口
 * 2. 通过懒加载避免在 import 时触发所有工具模块的副作用
 * 3. 支持按名称过滤（allowedTools 白名单）
 * 4. 支持动态注册 MCP 工具（在连接 MCP 服务器后添加）
 *
 * 与现有代码的关系：
 *   - 封装 src/tools.ts 中的 getAllBaseTools() / getTools() 函数
 *   - Tool 接口来自 src/Tool.ts（不导入，使用 unknown 避免循环依赖）
 *   - MCP 工具注册对应 AppState.mcp.tools 的管理
 *
 * 关键注意：
 *   Tool 接口中的 renderToolResultMessage/renderToolUseMessage 等方法依赖 React.ReactNode，
 *   但 ToolRegistry 不调用这些方法，只是持有 Tool 对象引用。
 *   因此 ToolRegistry 本身不引入 React 依赖。
 */

// ─── Tool 接口的最小化类型声明 ─────────────────────────────────────────────────

/**
 * Tool 接口的核心字段（用于 ToolRegistry 内部操作）。
 * 使用局部类型声明避免从 Tool.ts 导入（防止循环依赖）。
 *
 * 完整的 Tool 接口在 src/Tool.ts 中定义，包含约 60 个字段，
 * 其中许多是 React.ReactNode 类型，但 ToolRegistry 只需以下字段。
 */
interface ToolLike {
  name: string
  aliases?: string[]
  isMcp?: boolean
  isLsp?: boolean
  mcpInfo?: { serverName: string; toolName: string }
  isEnabled(): boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isReadOnly(input: any): boolean
}

// ─── ToolRegistry 类 ───────────────────────────────────────────────────────────

/**
 * 工具注册中心。
 *
 * 提供以下功能：
 * 1. 批量注册内置工具（fromBuiltins 静态方法）
 * 2. 动态注册单个工具（register 方法，用于 MCP 工具）
 * 3. 按名称查找工具（get 方法）
 * 4. 获取已启用的工具列表（getEnabledTools，供 QueryEngine 使用）
 * 5. 工具名称标准化（处理别名）
 */
export class ToolRegistry {
  /** 工具注册表（name → Tool） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tools: Map<string, any>
  /** 别名映射（alias → canonical name） */
  private aliases: Map<string, string>
  /** 工具描述缓存（name → description string） */
  private toolDescriptions: Map<string, string> = new Map()

  constructor() {
    this.tools = new Map()
    this.aliases = new Map()
  }

  // ─── 工具注册 ──────────────────────────────────────────────────────────

  /**
   * 注册单个工具。
   * 同名工具会被覆盖（后注册的优先，与 uniqBy 行为不同）。
   *
   * @param tool 任意符合 ToolLike 接口的工具对象
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(tool: any): void {
    const t = tool as ToolLike
    this.tools.set(t.name, tool)

    // 注册别名映射
    if (t.aliases) {
      for (const alias of t.aliases) {
        this.aliases.set(alias, t.name)
      }
    }
  }

  /**
   * 批量注册工具列表。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerMany(tools: readonly any[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  /**
   * 注销工具（通常用于 MCP 服务器断开时清理）。
   */
  unregister(name: string): void {
    const tool = this.tools.get(name)
    if (!tool) return

    this.tools.delete(name)

    // 清理别名
    const t = tool as ToolLike
    if (t.aliases) {
      for (const alias of t.aliases) {
        if (this.aliases.get(alias) === name) {
          this.aliases.delete(alias)
        }
      }
    }
  }

  // ─── 工具查找 ──────────────────────────────────────────────────────────

  /**
   * 按名称获取工具（支持别名查找）。
   *
   * @returns 工具对象，或 undefined（未找到）
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(name: string): any | undefined {
    // 先直接查找
    if (this.tools.has(name)) return this.tools.get(name)

    // 再查别名
    const canonicalName = this.aliases.get(name)
    if (canonicalName) return this.tools.get(canonicalName)

    return undefined
  }

  /**
   * 获取所有已注册工具（包含禁用的工具）。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  list(): any[] {
    return Array.from(this.tools.values())
  }

  /**
   * 获取已启用的工具列表（供 QueryEngine 使用）。
   *
   * 过滤逻辑：
   * 1. 调用 tool.isEnabled() 检查
   * 2. 如果提供 allowedToolNames，只返回名称在列表中的工具
   *
   * 对应现有代码：
   *   src/tools.ts 中的 getTools() 函数（含 isEnabled 过滤）
   *
   * @param allowedToolNames 工具名白名单（空数组或 undefined 表示不限制）
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getEnabledTools(allowedToolNames?: string[]): any[] {
    let tools = this.list()

    // 过滤禁用的工具
    tools = tools.filter(tool => {
      try {
        return (tool as ToolLike).isEnabled()
      } catch {
        return true  // 容错：isEnabled 出错时默认启用
      }
    })

    // 按名称白名单过滤
    if (allowedToolNames && allowedToolNames.length > 0) {
      const allowedSet = new Set(allowedToolNames)
      tools = tools.filter(tool => {
        const t = tool as ToolLike
        if (allowedSet.has(t.name)) return true
        if (t.aliases?.some(a => allowedSet.has(a))) return true
        return false
      })
    }

    return tools
  }

  /**
   * 获取已注册工具的数量。
   */
  get size(): number {
    return this.tools.size
  }

  /**
   * 检查工具是否已注册。
   */
  has(name: string): boolean {
    return this.tools.has(name) || this.aliases.has(name)
  }

  /**
   * 清空所有注册的工具。
   */
  clear(): void {
    this.tools.clear()
    this.aliases.clear()
    this.toolDescriptions.clear()
  }

  /**
   * 预加载所有工具的描述并缓存。
   * 在 fromBuiltins/fromSidecarSafeBuiltins 完成后调用，供 listTools() 同步读取。
   *
   * 工具描述来源（按优先级）：
   *   1. tool.prompt() —— async 方法（如果存在）
   *   2. tool.description —— string 字段（如果存在）
   */
  async preloadToolDescriptions(): Promise<void> {
    for (const [name, tool] of this.tools.entries()) {
      try {
        if (typeof tool.prompt === 'function') {
          const desc = await tool.prompt()
          this.toolDescriptions.set(name, typeof desc === 'string' ? desc : '')
        } else if (typeof tool.description === 'string') {
          this.toolDescriptions.set(name, tool.description)
        } else {
          this.toolDescriptions.set(name, '')
        }
      } catch {
        this.toolDescriptions.set(name, '')
      }
    }
  }

  /**
   * 获取工具的缓存描述。
   * 需先调用 preloadToolDescriptions() 才有返回値。
   */
  getCachedDescription(toolName: string): string | undefined {
    return this.toolDescriptions.get(toolName)
  }

  // ─── 静态工厂方法 ─────────────────────────────────────────────────────

  /**
   * 从现有 getAllBaseTools() 批量创建 ToolRegistry。
   *
   * 懒加载 tools.ts 模块，避免在模块初始化时触发所有工具的副作用。
   *
   * 对应现有代码：
   *   src/tools.ts 中的 getAllBaseTools() → 返回 Tool[] 数组
   *   此处将其注册到 ToolRegistry，便于按名称查找和动态修改。
   *
   * @param config 工具加载配置
   */
  static async fromBuiltins(config?: {
    /** 要排除的工具名称列表 */
    excludeTools?: string[]
    /** 仅加载这些工具（白名单，空=全部） */
    includeOnly?: string[]
  }): Promise<ToolRegistry> {
    const registry = new ToolRegistry()

    try {
      // 懒加载工具模块（避免在 import 时触发所有工具的副作用）
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const toolsModule = require('../tools.js') as typeof import('../tools.js')
      const allTools = toolsModule.getAllBaseTools()

      for (const tool of allTools) {
        // 应用排除规则
        if (config?.excludeTools?.includes(tool.name)) continue

        // 应用白名单规则
        if (config?.includeOnly && config.includeOnly.length > 0) {
          const t = tool as ToolLike
          const inWhitelist =
            config.includeOnly.includes(t.name) ||
            (t.aliases ?? []).some(a => config.includeOnly!.includes(a))
          if (!inWhitelist) continue
        }

        registry.register(tool)
      }
    } catch (err) {
      // 加载失败时记录错误，返回空注册表
      // 调用方可以后续通过 register() 手动添加工具
      console.error('[ToolRegistry] 加载内置工具失败:', err)
    }

    return registry
  }

  /**
   * 创建仅包含安全/只读工具的注册表。
   * 用于 plan-only 权限模式，确保不会注册写操作工具。
   *
   * 对应现有代码：
   *   src/tools.ts 中 isReplModeEnabled() 等模式过滤逻辑
   */
  static async fromReadOnlyBuiltins(): Promise<ToolRegistry> {
    const registry = await ToolRegistry.fromBuiltins()
    const readOnlyRegistry = new ToolRegistry()

    for (const tool of registry.list()) {
      try {
        // 测试空输入的只读性（对于只读工具，isReadOnly({}) 应返回 true）
        if ((tool as ToolLike).isReadOnly({})) {
          readOnlyRegistry.register(tool)
        }
      } catch {
        // isReadOnly 出错，跳过该工具
      }
    }

    return readOnlyRegistry
  }

  /**
   * 创建只包含 Sidecar 模式安全工具的注册表。
   *
   * Sidecar 安全工具是在无 UI 环境下可安全运行的工具集：
   * - 文件读写操作（FileRead, FileEdit, FileWrite）
   * - Bash 命令执行（BashTool，权限由 PermissionEngine 控制）
   * - 搜索工具（Glob, Grep）
   * - Web 工具（WebFetch, WebSearch）
   * - 代理工具（AgentTool，用于子任务）
   * - 其他无 UI 依赖的工具
   *
   * 排除的工具（需要 Ink/React UI）：
   * - AskUserQuestionTool（需要 REPL 交互）
   * - LSPTool（仅 REPL 模式有效）
   * - PermissionPromptTool（仅 REPL 模式有效）
   */
  static async fromSidecarSafeBuiltins(): Promise<ToolRegistry> {
    // 这些工具需要 REPL/UI 上下文，在 Sidecar 中无法安全使用
    const uiOnlyTools = new Set([
      'AskUserQuestion',       // 需要等待用户键盘输入
      'LSP',                   // 仅 REPL 模式
      'PermissionPromptTool',  // 内部权限 UI 工具
    ])

    const registry = await ToolRegistry.fromBuiltins({
      excludeTools: [...uiOnlyTools],
    })
    await registry.preloadToolDescriptions()
    return registry
  }
}
