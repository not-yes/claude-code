/**
 * sidecar/entry.ts
 *
 * Sidecar 模式启动入口。
 *
 * 当以 sidecar 模式运行时（process.env.SIDECAR_MODE === "true"），
 * 此文件负责：
 * 1. 初始化 AgentCore（加载配置、连接 MCP 等）
 * 2. 启动 JsonRpcServer，监听 stdin/stdout 上的 JSON-RPC 消息
 * 3. 注册 SIGTERM/SIGINT 信号处理，实现优雅关闭
 *
 * 无 React/Ink 依赖。此文件是 Bun Sidecar 可执行文件的入口点。
 *
 * 使用方式（构建时条件激活）：
 *   SIDECAR_MODE=true bun run src/sidecar/entry.ts
 */

// ─── MACRO 垫片 ────────────────────────────────────────────────────────────────
// MACRO 是 bun:bundle 的编译时宏，在 sidecar 编译时需要提供垫片
// @ts-ignore - 全局声明
globalThis.MACRO = globalThis.MACRO ?? {
  VERSION: '0.0.0',
  BUILD_TIME: '0',
  FEEDBACK_CHANNEL: '',
  ISSUES_EXPLAINER: '',
  NATIVE_PACKAGE_URL: '',
  PACKAGE_URL: '',
  VERSION_CHANGELOG: '',
  USER_TYPE: '',
}

// ─── bun:bundle feature 垫片 ────────────────────────────────────────────────────
// feature() 是 bun:bundle 的条件编译函数
// @ts-ignore - 全局声明
globalThis.feature = globalThis.feature ?? ((name: string) => {
  // sidecar 模式禁用所有特性
  return false
})

import { createAgentCore } from '../core/AgentCore'
import { JsonRpcServer } from './jsonRpcServer'
import { SessionStorage } from './storage/sessionStorage'
import type { AgentCoreConfig } from '../core/types'
import { enableConfigs } from '../utils/config.js'

// ─── 日志工具（发往 stderr，不干扰 stdout 协议）─────────────────────────────────

function log(level: 'INFO' | 'WARN' | 'ERROR', ...args: unknown[]): void {
  const timestamp = new Date().toISOString()
  process.stderr.write(`[${timestamp}] [${level}] [sidecar] ${args.join(' ')}\n`)
}

// ─── 配置读取 ──────────────────────────────────────────────────────────────────

/**
 * 从环境变量读取 Sidecar 配置。
 *
 * 支持的环境变量：
 *   SIDECAR_CWD               工作目录（默认 process.cwd()）
 *   SIDECAR_API_KEY           Anthropic API Key（不设则从 ANTHROPIC_API_KEY 读取）
 *   SIDECAR_PERMISSION_MODE   默认权限模式（默认 interactive）
 *   SIDECAR_PERSIST_SESSION   是否持久化会话（默认 true）
 *   SIDECAR_MAX_BUDGET_USD    最大费用预算 USD（可选）
 *   SIDECAR_DEBUG             是否启用调试日志（默认 false）
 *   SIDECAR_PERMISSION_TIMEOUT_MS  权限请求超时毫秒数（默认 300000）
 */
function readConfig(): {
  agentConfig: AgentCoreConfig
  debug: boolean
  permissionTimeoutMs: number
} {
  const cwd = process.env.SIDECAR_CWD ?? process.cwd()
  const apiKey = process.env.SIDECAR_API_KEY ?? process.env.ANTHROPIC_API_KEY

  const rawPermissionMode = process.env.SIDECAR_PERMISSION_MODE ?? 'interactive'
  const validPermissionModes = ['auto-approve', 'interactive', 'plan-only', 'deny-all'] as const
  type PermMode = typeof validPermissionModes[number]
  const defaultPermissionMode: PermMode = validPermissionModes.includes(
    rawPermissionMode as PermMode,
  )
    ? (rawPermissionMode as PermMode)
    : 'interactive'

  const persistSession = process.env.SIDECAR_PERSIST_SESSION !== 'false'
  const maxBudgetUsd = process.env.SIDECAR_MAX_BUDGET_USD
    ? parseFloat(process.env.SIDECAR_MAX_BUDGET_USD)
    : undefined

  const debug = process.env.SIDECAR_DEBUG === 'true'
  const permissionTimeoutMs = process.env.SIDECAR_PERMISSION_TIMEOUT_MS
    ? parseInt(process.env.SIDECAR_PERMISSION_TIMEOUT_MS, 10)
    : 300_000

  return {
    agentConfig: {
      cwd,
      apiKey,
      defaultPermissionMode,
      persistSession,
      maxBudgetUsd,
    },
    debug,
    permissionTimeoutMs,
  }
}

// ─── 配置验证 ─────────────────────────────────────────────────────────────────

/**
 * 验证 Sidecar 启动所需的关键配置。
 *
 * 仅记录警告/错误日志，不阻塞启动流程。
 * API key 缺失时不退出进程，让后续的 API 调用自然失败并返回明确错误。
 */
function validateConfig(agentConfig: AgentCoreConfig): void {
  // 验证 API Key
  const apiKey = agentConfig.apiKey
  if (!apiKey) {
    log('ERROR', 'No API key found. Set SIDECAR_API_KEY or ANTHROPIC_API_KEY environment variable.')
    log('WARN', 'Sidecar will start but API calls will fail without a valid API key.')
  } else {
    // 仅打印 key 前 8 位，避免泄露
    const maskedKey = apiKey.slice(0, 8) + '...'
    log('INFO', `API key detected: ${maskedKey}`)
  }

  // 验证工作目录
  const cwd = agentConfig.cwd
  if (!cwd) {
    log('WARN', 'No working directory specified. Falling back to process.cwd().')
  } else {
    log('INFO', `Working directory: ${cwd}`)
  }

  // 验证权限模式
  const permMode = agentConfig.defaultPermissionMode
  if (permMode === 'auto-approve') {
    log('WARN', 'Permission mode is auto-approve: all tool calls will be approved without prompting.')
  }

  // 验证预算上限
  if (agentConfig.maxBudgetUsd !== undefined) {
    if (isNaN(agentConfig.maxBudgetUsd) || agentConfig.maxBudgetUsd <= 0) {
      log('WARN', `Invalid maxBudgetUsd value: ${agentConfig.maxBudgetUsd}. Budget limit will not be enforced.`)
    } else {
      log('INFO', `Max budget: $${agentConfig.maxBudgetUsd} USD`)
    }
  }
}

// ─── 主启动函数 ────────────────────────────────────────────────────────────────

/**
 * Sidecar 进程主函数。
 *
 * 调用栈：
 *   main() → createAgentCore() → agent.initialize() → JsonRpcServer.start()
 *         → 等待 stdin 关闭（readline close 事件）
 *         → 优雅关闭
 */
async function main(): Promise<void> {
  log('INFO', '启动 Sidecar 进程...')

  // 1. 读取配置
  const { agentConfig, debug, permissionTimeoutMs } = readConfig()
  log('INFO', `权限模式: ${agentConfig.defaultPermissionMode}`)
  log('INFO', `调试日志: ${debug}`)

  // 1.5 配置验证（在 AgentCore 初始化之前校验关键参数）
  validateConfig(agentConfig)

  // 启用配置读取（必须在 AgentCore 初始化之前）
  enableConfigs()
  log('INFO', '配置系统已启用')

  // 2. 初始化 SessionStorage
  let sessionStorage: SessionStorage | undefined
  if (agentConfig.persistSession !== false) {
    sessionStorage = new SessionStorage()
    try {
      await sessionStorage.initialize()
      log('INFO', 'SessionStorage 初始化完成')
    } catch (err) {
      log('WARN', 'SessionStorage 初始化失败，会话将不被持久化:', err instanceof Error ? err.message : String(err))
      sessionStorage = undefined
    }
  }

  // 3. 创建 AgentCore
  log('INFO', '正在初始化 AgentCore...')
  let agentCore: Awaited<ReturnType<typeof createAgentCore>>
  try {
    agentCore = await createAgentCore(agentConfig, undefined, sessionStorage)
    await agentCore.initialize()
    log('INFO', 'AgentCore 初始化完成')
  } catch (err) {
    log('ERROR', 'AgentCore 初始化失败:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  // 3. 创建并启动 JsonRpcServer
  const server = new JsonRpcServer(agentCore, {
    debug,
    permissionTimeoutMs,
  })

  // 4. 注册优雅关闭处理器
  let isShuttingDown = false

  async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) return
    isShuttingDown = true

    log('INFO', `收到 ${signal} 信号，开始优雅关闭...`)

    try {
      // 4.1 停止 JsonRpcServer（中止所有流、拒绝待处理权限请求）
      await server.stop()
      log('INFO', 'JsonRpcServer 已停止')

      // 4.2 关闭 AgentCore（断开 MCP 连接等）
      await agentCore.shutdown()
      log('INFO', 'AgentCore 已关闭')

      log('INFO', 'Sidecar 进程已优雅关闭')
      process.exit(0)
    } catch (err) {
      log('ERROR', '优雅关闭时出错:', err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  }

  // SIGTERM：Tauri 关闭 sidecar 时发送的标准信号
  process.on('SIGTERM', () => {
    gracefulShutdown('SIGTERM').catch(err => {
      log('ERROR', 'SIGTERM 处理异常:', err)
      process.exit(1)
    })
  })

  // SIGINT：Ctrl+C 中断（开发调试时使用）
  process.on('SIGINT', () => {
    gracefulShutdown('SIGINT').catch(err => {
      log('ERROR', 'SIGINT 处理异常:', err)
      process.exit(1)
    })
  })

  // 未捕获异常：防止进程无声崩溃
  process.on('uncaughtException', (err: Error) => {
    log('ERROR', '未捕获异常:', err.message, err.stack ?? '')
    // 不立即退出，给优雅关闭一次机会
    gracefulShutdown('uncaughtException').catch(() => process.exit(1))
  })

  // 未处理的 Promise 拒绝
  process.on('unhandledRejection', (reason: unknown) => {
    log(
      'ERROR',
      '未处理的 Promise 拒绝:',
      reason instanceof Error ? reason.message : String(reason),
    )
  })

  // stdin 关闭（host 进程退出）→ 触发关闭
  process.stdin.on('close', () => {
    log('INFO', 'stdin 已关闭，host 进程可能已退出')
    if (!isShuttingDown) {
      gracefulShutdown('stdin_close').catch(() => process.exit(1))
    }
  })

  // 5. 启动服务
  server.start()
  log('INFO', 'JsonRpcServer 已启动，等待 JSON-RPC 请求...')

  // 输出就绪信号到 stdout（Tauri host 等待此消息确认 sidecar 已就绪）
  // 格式：JSON-RPC notification（不带 id）
  const readyNotification = JSON.stringify({
    jsonrpc: '2.0',
    method: '$/ready',
    params: {
      version: '1.0.0',
      cwd: agentConfig.cwd,
      permissionMode: agentConfig.defaultPermissionMode,
    },
  })
  process.stdout.write(readyNotification + '\n')

  log('INFO', '已发送就绪信号，Sidecar 进程运行中')
}

// ─── 启动条件检查 ──────────────────────────────────────────────────────────────

/**
 * 仅在 SIDECAR_MODE=true 时激活 Sidecar 入口。
 *
 * 构建时条件（与 scripts/build.ts 配合）：
 *   当 SIDECAR_MODE=true 时，此文件作为独立 bundle 的入口点被编译。
 *   当作为普通 CLI 构建时，此文件不会被执行（通过 feature flag 或条件 import 跳过）。
 */
if (process.env.SIDECAR_MODE === 'true') {
  main().catch(err => {
    process.stderr.write(
      `[FATAL] Sidecar 启动失败: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n')
    }
    process.exit(1)
  })
}

// ─── 导出（供其他模块复用）────────────────────────────────────────────────────

export { main as startSidecar }
export type { JsonRpcServerOptions } from './jsonRpcServer'
