/**
 * core/PermissionEngine.ts
 *
 * 纯权限决策引擎（不依赖 React/Ink/readline）。
 *
 * 设计原则：
 * 1. 纯逻辑实现，所有决策基于规则和缓存，不涉及任何 UI 展示
 * 2. 提取并复用 src/utils/permissions/permissions.ts 中的规则匹配逻辑
 * 3. 替代 src/hooks/useCanUseTool.tsx 中基于 React context 的权限检查
 * 4. 决策结果可缓存（remember=true 时写入持久规则）
 *
 * 与现有代码的关系：
 *   - CorePermissionRule 对应 src/utils/permissions/PermissionRule.ts 的 PermissionRule
 *   - 'allow'/'deny'/'ask' 行为对应现有 PermissionBehavior 类型
 *   - glob 模式匹配逻辑复用 src/utils/permissions/permissionRuleParser.ts
 *   - 持久化写入通过 src/utils/permissions/PermissionUpdate.ts 实现
 */

import type { CorePermissionRule, PermissionDecision } from './types.js'

// ─── 会话级权限缓存条目 ────────────────────────────────────────────────────────

/**
 * 会话级权限缓存条目。
 * 用于在一次会话中记住用户的权限决策，避免重复询问。
 *
 * 对应现有代码：
 *   ToolPermissionContext.alwaysAllowRules 中的运行时规则，
 *   区别在于这些规则只在当前 PermissionEngine 实例有效，不持久化到磁盘。
 */
interface SessionCacheEntry {
  toolName: string
  /** 规则内容（如 glob 模式）；null 表示匹配该工具的所有输入 */
  ruleContent: string | null
  granted: boolean
  cachedAt: number
}

// ─── 权限模式匹配结果 ──────────────────────────────────────────────────────────

/**
 * 规则评估结果。
 * null 表示没有规则覆盖此次调用（需要上层决定）。
 */
export interface RuleEvaluationResult {
  granted: boolean
  source: 'alwaysAllow' | 'alwaysDeny' | 'alwaysAsk' | 'session_cache'
  matchedRule?: CorePermissionRule
  denyReason?: string
}

// ─── PermissionEngine 类 ───────────────────────────────────────────────────────

/**
 * 纯权限决策引擎。
 *
 * 职责：
 * 1. 评估 alwaysAllow/alwaysDeny/alwaysAsk 规则（对应 ToolPermissionContext 中的规则集）
 * 2. 管理会话级权限缓存（replace React hooks 中的 setToolPermissionContext 逻辑）
 * 3. 提供 glob 模式匹配（复用现有 permissionRuleParser.ts 的逻辑）
 *
 * 不负责：
 * - UI 交互（由 onPermissionRequest 回调处理）
 * - 持久化写入（由 PermissionUpdate.ts 处理）
 * - 分类器调用（由 yoloClassifier.ts 处理）
 */
export class PermissionEngine {
  /** 初始规则集（来自 settings.json 的 alwaysAllow/alwaysDeny 配置） */
  private rules: CorePermissionRule[]
  /** 会话级运行时缓存（用户在本次会话中确认的规则） */
  private sessionCache: Map<string, SessionCacheEntry>
  /**
   * glob 模式匹配函数（懒加载，避免在 import 时触发大模块加载）。
   * 对应 src/utils/permissions/permissionRuleParser.ts 中的解析逻辑。
   */
  private matchPattern: ((pattern: string, value: string) => boolean) | null = null
  /** 懒加载的 picomatch 库实例（用于精确 glob 匹配） */
  private _picomatch: any = null

  constructor(initialRules: CorePermissionRule[] = []) {
    this.rules = [...initialRules]
    this.sessionCache = new Map()
  }

  // ─── 核心评估逻辑 ──────────────────────────────────────────────────────

  /**
   * 评估是否允许工具执行。
   *
   * 评估顺序（与现有 permissions.ts 中的 getPermission 逻辑对齐）：
   * 1. 检查 session_cache（用户本次会话中已确认的临时规则）
   * 2. 检查 alwaysDeny 规则（拒绝优先于允许）
   * 3. 检查 alwaysAllow 规则
   * 4. 检查 alwaysAsk 规则（强制 ask，即使有 alwaysAllow 也问）
   *
   * @param toolName 工具名称
   * @param input 工具输入参数（用于 glob 模式匹配）
   * @returns 评估结果，null 表示无规则覆盖（由调用方根据权限模式决定）
   */
  evaluate(
    toolName: string,
    input: unknown,
  ): (PermissionDecision & { source: string }) | null {
    // 提取用于规则匹配的字符串（通常是路径或命令）
    const matchTarget = this.extractMatchTarget(toolName, input)

    // 1. 检查会话缓存
    const cacheKey = this.buildCacheKey(toolName, matchTarget)
    const cached = this.sessionCache.get(cacheKey)
    if (cached) {
      return {
        granted: cached.granted,
        source: 'session_cache',
        remember: false,
      }
    }

    // 2. 检查 alwaysDeny 规则（拒绝优先）
    const denyRule = this.findMatchingRule('deny', toolName, matchTarget)
    if (denyRule) {
      return {
        granted: false,
        source: 'alwaysDeny',
        denyReason: `工具 ${toolName} 匹配了拒绝规则：${
          denyRule.value.ruleContent ?? '（任意输入）'
        }`,
      }
    }

    // 3. 检查 alwaysAsk 规则（强制交互确认，即使下面有 alwaysAllow）
    const askRule = this.findMatchingRule('ask', toolName, matchTarget)
    if (askRule) {
      // 返回 null 表示"需要询问"（由 AgentCore 的 onPermissionRequest 处理）
      return null
    }

    // 4. 检查 alwaysAllow 规则
    const allowRule = this.findMatchingRule('allow', toolName, matchTarget)
    if (allowRule) {
      return {
        granted: true,
        source: 'alwaysAllow',
        remember: false,
      }
    }

    // 无规则覆盖
    return null
  }

  /**
   * 将用户决策缓存到会话级缓存。
   * 当 onPermissionRequest 返回 remember=true 时调用。
   *
   * 对应现有代码：
   *   src/hooks/toolPermission/handlers/ 中的 setToolPermissionContext 调用，
   *   这些 handler 将用户决策写入 AppState.toolPermissionContext.alwaysAllowRules。
   *   此处改为写入 sessionCache（无 React 依赖）。
   *
   * @param toolName 工具名称
   * @param decision 用户的权限决策
   */
  remember(toolName: string, decision: PermissionDecision): void {
    const cacheKey = this.buildCacheKey(toolName, null)
    this.sessionCache.set(cacheKey, {
      toolName,
      ruleContent: null,
      granted: decision.granted,
      cachedAt: Date.now(),
    })

    // 如果用户选择持久化，同时添加到内存规则集
    // （持久化到 settings.json 需要通过 PermissionUpdate.ts，此处不做）
    if (decision.granted) {
      this.addRule({
        behavior: 'allow',
        value: { toolName },
      })
    } else {
      this.addRule({
        behavior: 'deny',
        value: { toolName },
      })
    }
  }

  /**
   * 添加规则到运行时规则集。
   * 这些规则只在当前引擎实例有效，不持久化到 settings.json。
   */
  addRule(rule: CorePermissionRule): void {
    // 检查是否已存在相同规则（避免重复）
    const exists = this.rules.some(
      r =>
        r.behavior === rule.behavior &&
        r.value.toolName === rule.value.toolName &&
        r.value.ruleContent === rule.value.ruleContent,
    )
    if (!exists) {
      this.rules.push(rule)
    }
  }

  /**
   * 移除指定规则。
   */
  removeRule(toolName: string, behavior: CorePermissionRule['behavior']): void {
    this.rules = this.rules.filter(
      r => !(r.value.toolName === toolName && r.behavior === behavior),
    )
  }

  /**
   * 清空会话缓存（在 /clear 命令后调用）。
   */
  clearSessionCache(): void {
    this.sessionCache.clear()
  }

  /**
   * 获取当前所有规则（只读快照）。
   */
  getRules(): readonly CorePermissionRule[] {
    return [...this.rules]
  }

  /**
   * 从 ToolPermissionContext 批量导入规则。
   *
   * 用于在 AgentCore 初始化时，将现有 AppState.toolPermissionContext
   * 中的规则同步到 PermissionEngine。
   *
   * 对应现有代码：
   *   ToolPermissionContext.alwaysAllowRules / alwaysDenyRules / alwaysAskRules
   *   这些是 Map<source, PermissionRuleValue[]> 结构。
   */
  importFromPermissionContext(ctx: {
    alwaysAllowRules: Record<string, Array<{ toolName: string; ruleContent?: string }>>
    alwaysDenyRules: Record<string, Array<{ toolName: string; ruleContent?: string }>>
    alwaysAskRules?: Record<string, Array<{ toolName: string; ruleContent?: string }>>
  }): void {
    // 导入 alwaysAllow 规则
    for (const ruleValues of Object.values(ctx.alwaysAllowRules)) {
      for (const rv of ruleValues) {
        this.addRule({
          behavior: 'allow',
          value: { toolName: rv.toolName, ruleContent: rv.ruleContent },
        })
      }
    }

    // 导入 alwaysDeny 规则
    for (const ruleValues of Object.values(ctx.alwaysDenyRules)) {
      for (const rv of ruleValues) {
        this.addRule({
          behavior: 'deny',
          value: { toolName: rv.toolName, ruleContent: rv.ruleContent },
        })
      }
    }

    // 导入 alwaysAsk 规则
    if (ctx.alwaysAskRules) {
      for (const ruleValues of Object.values(ctx.alwaysAskRules)) {
        for (const rv of ruleValues) {
          this.addRule({
            behavior: 'ask',
            value: { toolName: rv.toolName, ruleContent: rv.ruleContent },
          })
        }
      }
    }
  }

  // ─── 私有辅助方法 ─────────────────────────────────────────────────────

  /**
   * 在规则列表中查找匹配的规则。
   *
   * 匹配逻辑（与现有代码对齐）：
   * 1. 工具名精确匹配
   * 2. 若规则有 ruleContent（glob 模式），额外匹配 matchTarget
   *
   * 对应现有代码：
   *   src/utils/permissions/permissions.ts 中的 checkAgainstRules 函数
   */
  private findMatchingRule(
    behavior: CorePermissionRule['behavior'],
    toolName: string,
    matchTarget: string | null,
  ): CorePermissionRule | undefined {
    return this.rules.find(rule => {
      if (rule.behavior !== behavior) return false
      if (rule.value.toolName !== toolName) return false

      // 如果没有 ruleContent，则匹配该工具的所有输入
      if (!rule.value.ruleContent) return true

      // 有 ruleContent 时，需要匹配 matchTarget
      if (!matchTarget) return false

      return this.matchesPattern(rule.value.ruleContent, matchTarget)
    })
  }

  /**
   * 检查 matchTarget 是否匹配给定的 glob 模式。
   *
   * 对应现有代码：
   *   src/utils/permissions/shellRuleMatching.ts 中的 matchShellPattern
   *   src/utils/permissions/pathValidation.ts 中的路径 glob 匹配
   *
   * 这里提供一个简化实现，支持基本的通配符匹配：
   *   - '*' 匹配任意字符（不包括路径分隔符）
   *   - '**' 匹配任意字符（包括路径分隔符）
   */
  private matchesPattern(pattern: string, target: string): boolean {
    // 如果有懒加载的匹配函数，优先使用
    if (this.matchPattern) {
      return this.matchPattern(pattern, target)
    }

    // 内置简化实现：将 glob 转为正则
    return this.globMatch(pattern, target)
  }

  /**
   * glob 匹配实现，优先使用 picomatch 库，回退到简化正则实现。
   * 支持 `{a,b}`、`?`、`[abc]` 等复杂 glob 模式（通过 picomatch）。
   *
   * 完整实现参考 src/utils/permissions/pathValidation.ts 中的 micromatch 调用。
   */
  private globMatch(pattern: string, target: string): boolean {
    try {
      // 懒加载 picomatch（避免启动时影响性能）
      if (!this._picomatch) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        this._picomatch = require('picomatch')
      }
      return this._picomatch.isMatch(target, pattern)
    } catch {
      // picomatch 不可用时，回退到简化正则实现
      return this.simpleGlobMatch(pattern, target)
    }
  }

  /**
   * 简化的 glob 匹配 fallback 实现。
   * 支持 '*'（不含路径分隔符）、'**'（含路径分隔符）、'?'（单个非分隔符字符）。
   */
  private simpleGlobMatch(pattern: string, target: string): boolean {
    // 转义正则特殊字符，然后替换 glob 语法（注意：不转义 [ ] 以支持字符类）
    const regexStr = pattern
      .replace(/[.+^${}()|\\]/g, '\\$&')      // 转义特殊字符（保留 [ ]）
      .replace(/\*\*/g, '§DOUBLESTAR§')        // 临时替换 **
      .replace(/\*/g, '[^/]*')                  // * 不匹配路径分隔符
      .replace(/\?/g, '[^/]')                   // ? 匹配单个非分隔符字符
      .replace(/§DOUBLESTAR§/g, '.*')           // ** 匹配所有字符

    try {
      return new RegExp(`^${regexStr}$`).test(target)
    } catch {
      // 正则构建失败，回退到精确匹配
      return pattern === target
    }
  }

  /**
   * 从工具输入中提取用于规则匹配的字符串。
   *
   * 不同工具的 matchTarget 提取策略：
   *   - Bash: command 字段
   *   - FileRead/FileWrite/FileEdit: file_path 字段
   *   - Glob: pattern 字段
   *   - Grep: pattern + path 字段
   *   - 其他: JSON 序列化后的完整输入
   *
   * 对应现有代码：
   *   Tool.preparePermissionMatcher?.(input) 的返回值
   *   各 tool 的 getPath?(input) 方法
   */
  private extractMatchTarget(toolName: string, input: unknown): string | null {
    if (!input || typeof input !== 'object') return null

    const inp = input as Record<string, unknown>

    // 根据工具名提取关键字段
    switch (toolName) {
      case 'Bash':
      case 'bash':
        return typeof inp.command === 'string' ? inp.command : null

      case 'Read':
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookEdit':
      case 'NotebookRead':
        return typeof inp.file_path === 'string' ? inp.file_path : null

      case 'Glob':
        return typeof inp.pattern === 'string' ? inp.pattern : null

      case 'Grep':
        return typeof inp.pattern === 'string' ? inp.pattern : null

      case 'WebFetch':
        return typeof inp.url === 'string' ? inp.url : null

      default:
        // 对其他工具，尝试提取 command/path/url 等通用字段
        for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
          if (typeof inp[key] === 'string') {
            return inp[key] as string
          }
        }
        return null
    }
  }

  /**
   * 构建会话缓存的 key。
   * 格式：{toolName}:{matchTarget}
   */
  private buildCacheKey(toolName: string, matchTarget: string | null): string {
    return matchTarget ? `${toolName}:${matchTarget}` : toolName
  }

  /**
   * 注入外部 glob 匹配函数（用于集成现有 micromatch/minimatch 实现）。
   *
   * 调用方可以在初始化后注入更准确的匹配实现：
   * ```typescript
   * const engine = new PermissionEngine(rules);
   * engine.setPatternMatcher((pattern, value) => micromatch.isMatch(value, pattern));
   * ```
   */
  setPatternMatcher(fn: (pattern: string, value: string) => boolean): void {
    this.matchPattern = fn
  }
}

// ─── 工厂辅助函数 ──────────────────────────────────────────────────────────────

/**
 * 从现有 ToolPermissionContext 创建 PermissionEngine。
 *
 * 用于将 CLI 模式的 AppState.toolPermissionContext 迁移到 PermissionEngine，
 * 实现平滑过渡。
 *
 * 对应现有代码：
 *   src/utils/permissions/permissionSetup.ts 中的权限上下文初始化
 */
export function createPermissionEngineFromContext(
  // 使用 unknown 避免直接导入 ToolPermissionContext（防止循环依赖）
  permissionContext: unknown,
): PermissionEngine {
  const ctx = permissionContext as {
    alwaysAllowRules?: Record<string, Array<{ toolName: string; ruleContent?: string }>>
    alwaysDenyRules?: Record<string, Array<{ toolName: string; ruleContent?: string }>>
    alwaysAskRules?: Record<string, Array<{ toolName: string; ruleContent?: string }>>
  }

  const engine = new PermissionEngine()
  engine.importFromPermissionContext({
    alwaysAllowRules: ctx.alwaysAllowRules ?? {},
    alwaysDenyRules: ctx.alwaysDenyRules ?? {},
    alwaysAskRules: ctx.alwaysAskRules,
  })

  return engine
}
