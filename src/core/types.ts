/**
 * core/types.ts
 *
 * Sidecar 模式下的核心类型定义。
 * 本文件不依赖任何 React/Ink/readline 模块，可安全用于无 UI 环境。
 *
 * 与现有代码的关系：
 * - StreamEvent 是现有 src/types/message.ts 中 StreamEvent 的 Sidecar 视图投影
 * - PermissionMode 对应 src/utils/permissions/PermissionMode.ts 中的 PermissionMode 类型
 * - AppCoreState 是从 bootstrap/state.ts 提取的会话级无 UI 状态
 */

// ─── 流式事件类型 ──────────────────────────────────────────────────────────────

/**
 * Sidecar 对外暴露的流式事件类型。
 * 调用方通过 AsyncGenerator<StreamEvent> 消费 Agent 的实时输出。
 *
 * 与 src/types/message.ts 中 StreamEvent 的关系：
 *   内部 StreamEvent 包含完整的 Message 对象（含元数据、UI 字段等），
 *   此处是精简的外部视图，适合 WebSocket/HTTP 传输。
 */
export type SidecarStreamEvent =
  | {
      /** 模型输出的文本片段 */
      type: 'text'
      content: string
      /** 是否为思考块（Claude 的 extended thinking） */
      isThinking?: boolean
    }
  | {
      /** 模型发起工具调用 */
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
    }
  | {
      /** 工具调用执行完成，返回结果 */
      type: 'tool_result'
      id: string
      toolName: string
      result: unknown
      isError?: boolean
      filePath?: string      // 新增：工具创建/修改的文件路径
    }
  | {
      /** 需要用户授权的权限请求（仅 interactive 模式） */
      type: 'permission_request'
      requestId: string
      tool: string
      action: string
      path?: string
      description?: string
    }
  | {
      /** 系统级消息（如模型切换、压缩完成等通知） */
      type: 'system_message'
      level: 'info' | 'warning' | 'error'
      content: string
    }
  | {
      /** 上下文压缩事件（autocompact/compact 触发） */
      type: 'context_compact'
      preTokenCount: number
      postTokenCount: number
    }
  | {
      /** 查询出错 */
      type: 'error'
      message: string
      code?: string
    }
  | {
      /** 本轮查询完成 */
      type: 'complete'
      usage?: {
        inputTokens: number
        outputTokens: number
        cacheReadTokens?: number
        cacheCreationTokens?: number
      }
      /** 结束原因，对应 query.ts 中 Terminal.reason */
      reason:
        | 'completed'
        | 'aborted_streaming'
        | 'aborted_tools'
        | 'max_turns'
        | 'prompt_too_long'
        | 'blocking_limit'
        | 'model_error'
        | 'hook_stopped'
        | 'stop_hook_prevented'
        | 'image_error'
        | string
    }

// ─── 权限系统类型 ──────────────────────────────────────────────────────────────

/**
 * 权限请求：由 PermissionEngine 或回调机制发送给调用方。
 *
 * 对应现有代码：
 *   - src/hooks/useCanUseTool.tsx 中的权限检查逻辑
 *   - PermissionResult 中的 'ask' behavior
 */
export interface PermissionRequest {
  /** 请求唯一 ID，用于匹配 PermissionDecision */
  requestId: string
  /** 工具名称（如 'Bash', 'FileWrite'） */
  tool: string
  /** 操作描述（如命令字符串、文件路径操作类型） */
  action: string
  /** 涉及的文件路径（可选，文件类工具提供） */
  path?: string
  /** 人类可读的描述，用于向用户展示 */
  description?: string
  /** 工具调用的完整输入参数 */
  toolInput?: Record<string, unknown>
}

/**
 * 权限决策：调用方返回给 PermissionEngine 的决策结果。
 */
export interface PermissionDecision {
  /** true = 允许，false = 拒绝 */
  granted: boolean
  /**
   * 是否记住该决策（写入 alwaysAllow/alwaysDeny 规则）。
   * 对应现有代码中的 PermissionUpdate 持久化逻辑。
   */
  remember?: boolean
  /** 自定义拒绝理由（显示给模型） */
  denyReason?: string
  /**
   * 决策来源与原因（用于审计和日志追踪）。
   * type: 决策来源（如 'user' | 'system' | 'policy'）
   * action: 具体动作（如 'approved' | 'denied'）
   * reason: 可选的原因描述
   */
  decisionReason?: {
    type: string
    action: string
    reason?: string
  }
  /** AskUserQuestion 工具收集的用户答案（question text → answer string） */
  answers?: Record<string, string>
  /** ExitPlanMode 等工具的更新输入（如编辑后的 plan） */
  updatedInput?: Record<string, unknown>
}

// ─── 权限模式 ──────────────────────────────────────────────────────────────────

/**
 * 权限模式，与 src/types/permissions.ts 中的 PermissionMode 对应。
 *
 * 'auto-approve'    = 对应内部的 'bypassPermissions' / 'acceptEdits'
 * 'interactive'     = 对应内部的 'default'（需用户逐个确认）
 * 'plan-only'       = 对应内部的 'plan'（只读规划模式，不执行写操作）
 * 'deny-all'        = 所有需要确认的操作自动拒绝
 */
export type CorePermissionMode =
  | 'auto-approve'
  | 'interactive'
  | 'plan-only'
  | 'deny-all'

// ─── 执行选项 ──────────────────────────────────────────────────────────────────

/**
 * AgentCore.execute() 的执行选项。
 * 对应 QueryEngineConfig 中的各项参数。
 */
export interface ExecuteOptions {
  /** 指定模型（如 'claude-opus-4-5'），不指定则使用默认模型 */
  model?: string
  /** 最大输出 token 数 */
  maxOutputTokens?: number
  /** 覆盖默认 system prompt */
  systemPrompt?: string
  /** 追加到 system prompt 末尾的内容 */
  appendSystemPrompt?: string
  /** 允许使用的工具名列表（空数组=不限制） */
  allowedTools?: string[]
  /** 权限模式 */
  permissionMode?: CorePermissionMode
  /** 最大轮次（防止无限循环） */
  maxTurns?: number
  /** 是否开启 extended thinking */
  enableThinking?: boolean
  /** 请求唯一 ID（用于幂等性控制） */
  requestId?: string
  /** Agent ID - 加载对应 agent 的 skills 和配置 */
  agentId?: string
  /** 工作目录 - 运行时指定（优先于 config.cwd） */
  cwd?: string
}

// ─── 会话类型 ──────────────────────────────────────────────────────────────────

/**
 * 会话元数据。
 * 对应现有代码中 sessionStorage.ts 的会话持久化结构。
 */
export interface Session {
  /** 会话 UUID */
  id: string
  /** 创建时间（ISO 8601） */
  createdAt: string
  /** 最后更新时间（ISO 8601） */
  updatedAt: string
  /** 会话消息历史（使用 unknown 保持类型灵活性） */
  messages: unknown[]
  /** 自定义元数据（用于业务层标记） */
  metadata?: Record<string, unknown>
}

/**
 * 创建会话的参数。
 */
export interface SessionParams {
  /** 会话名称（可选，用于展示） */
  name?: string
  /** 指定模型 */
  model?: string
  /** 会话级 system prompt */
  systemPrompt?: string
  /** 工作目录 */
  cwd?: string
}

// ─── 工具信息 ──────────────────────────────────────────────────────────────────

/**
 * 工具的简化信息描述，用于 AgentCore.listTools() 返回值。
 * 对应 Tool 接口中的 name 和 description 字段。
 */
export interface ToolInfo {
  name: string
  description: string
  /** 是否只读（不修改文件系统/执行命令） */
  isReadOnly: boolean
  /** 是否来自 MCP 服务器 */
  isMcp: boolean
  /** MCP 服务器信息（当 isMcp=true 时存在） */
  mcpInfo?: { serverName: string; toolName: string }
}

// ─── AgentCore 配置 ────────────────────────────────────────────────────────────

/**
 * AgentCore 工厂函数的配置参数。
 * 这是将现有 QueryEngineConfig 解耦后的 Sidecar 友好版本。
 */
export interface AgentCoreConfig {
  /** 工作目录 */
  cwd: string
  /** API 密钥（不设置则从环境变量读取） */
  apiKey?: string
  /** 默认权限模式 */
  defaultPermissionMode?: CorePermissionMode
  /** 是否启用会话持久化 */
  persistSession?: boolean
  /** 额外配置（传递给底层 QueryEngine） */
  maxBudgetUsd?: number
  /** MCP 客户端列表（可选，通过构造函数或 setMcpClients 注入） */
  mcpClients?: any[]
}

// ─── 权限规则（纯数据结构） ────────────────────────────────────────────────────

/**
 * 权限规则，对应 src/utils/permissions/PermissionRule.ts 中的 PermissionRule。
 * 此处简化为纯数据结构，不含 Zod schema 依赖。
 */
export interface CorePermissionRule {
  /** 规则行为：允许/拒绝/询问 */
  behavior: 'allow' | 'deny' | 'ask'
  /** 规则值：工具名 + 可选的规则内容（如 glob 模式） */
  value: {
    toolName: string
    ruleContent?: string
  }
}

// ─── 状态快照 ──────────────────────────────────────────────────────────────────

/**
 * AgentCore 的可观测状态快照。
 * 这是从 AppState（含 UI 字段）中提取的纯核心状态，
 * 替代 bootstrap/state.ts 中的 React 绑定状态。
 */
export interface CoreState {
  /** 当前工作目录 */
  cwd: string
  /** 会话 ID */
  sessionId: string
  /** 当前权限模式 */
  permissionMode: CorePermissionMode
  /** alwaysAllow 规则列表 */
  alwaysAllowRules: CorePermissionRule[]
  /** alwaysDeny 规则列表 */
  alwaysDenyRules: CorePermissionRule[]
  /** 累计费用（USD） */
  totalCostUsd: number
  /** Token 使用量统计 */
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  }
}
