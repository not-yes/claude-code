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
// Sidecar 模式下选择性启用必要的特性门控
const SIDECAR_ENABLED_FEATURES = new Set([
  'AGENT_TRIGGERS',  // 启用 CronCreate/CronDelete/CronList 工具，支持自然语言创建定时任务
])
globalThis.feature = globalThis.feature ?? ((name: string) => {
  return SIDECAR_ENABLED_FEATURES.has(name)
})

import { createAgentCore } from '../core/AgentCore'
import { JsonRpcServer } from './jsonRpcServer'
import { SessionStorage } from './storage/sessionStorage'
import type { AgentCoreConfig } from '../core/types'
import { enableConfigs } from '../utils/config.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'
import { SidecarCronScheduler } from './cronScheduler.js'
import { readJobs, writeJobs } from './handlers/cronHandler.js'
import { join } from 'path'
import { homedir } from 'os'
import { mkdir } from 'fs/promises'
import { restoreCostStateForSession, saveCurrentSessionCosts } from '../cost-tracker.js'

// ─── 日志工具（发往 stderr，不干扰 stdout 协议）─────────────────────────────────

function log(level: 'INFO' | 'WARN' | 'ERROR', ...args: unknown[]): void {
  const timestamp = new Date().toISOString()
  process.stderr.write(`[${timestamp}] [${level}] [sidecar] ${args.join(' ')}\n`)
}

// ─── 配置读取 ──────────────────────────────────────────────────────────────────

/**
 * 从环境变量读取 Sidecar 配置。
 *
 * 注意：此函数必须在 enableConfigs() 和 applyConfigEnvironmentVariables() 之后调用，
 * 以确保 settings.json env 字段的变量（如 ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 等）
 * 已被注入到 process.env 中。
 *
 * 支持的环境变量：
 *   SIDECAR_CWD               工作目录（默认 process.cwd()）
 *   ANTHROPIC_API_KEY         Anthropic API Key（sk-ant-...），通过 x-api-key 请求头认证
 *   ANTHROPIC_AUTH_TOKEN      Claude Pro OAuth Token（sk-cp-...），通过 Authorization: Bearer 请求头认证
 *   SIDECAR_PERMISSION_MODE   默认权限模式（默认 interactive）
 *   SIDECAR_PERSIST_SESSION   是否持久化会话（默认 true）
 *   SIDECAR_MAX_BUDGET_USD    最大费用预算 USD（可选）
 *   SIDECAR_DEBUG             是否启用调试日志（默认 false）
 *   SIDECAR_PERMISSION_TIMEOUT_MS  权限请求超时毫秒数（默认 300000）
 *   AGENT_ID                  Agent 实例标识符（默认 'main'），用于隔离 Session 存储路径
 */
function readConfig(): {
  agentConfig: AgentCoreConfig
  debug: boolean
  permissionTimeoutMs: number
  agentId: string
} {
  const cwd = process.env.SIDECAR_CWD ?? process.cwd()
  // 不手动设置 apiKey：applyConfigEnvironmentVariables() 已将 settings.json env 字段注入到
  // process.env，AgentCore 内部会自己读取 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN，
  // 跟 CLI 模式完全一致，无需前端或 Rust 端传递。

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

  const agentId = process.env.AGENT_ID ?? 'main'

  return {
    agentConfig: {
      cwd,
      defaultPermissionMode,
      persistSession,
      maxBudgetUsd,
    },
    debug,
    permissionTimeoutMs,
    agentId,
  }
}

// ─── 配置验证 ─────────────────────────────────────────────────────────────────

/**
 * 配置验证结果
 */
interface ConfigValidation {
  hasApiKey: boolean
  warnings: string[]
  errors: string[]
}

/**
 * 验证 Sidecar 启动所需的关键配置。
 *
 * 返回结构化验证结果，供调用方决定是否通过 JSON-RPC notification 通知前端。
 * 不阻塞启动流程：API key 缺失时让后续 API 调用自然失败并返回明确错误。
 */
function validateConfig(agentConfig: AgentCoreConfig): ConfigValidation {
  const result: ConfigValidation = { hasApiKey: true, warnings: [], errors: [] }

  // 验证认证配置：ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY 其一存在即可
  // 注意：这些变量已由 applyConfigEnvironmentVariables() 从 settings.json env 字段注入
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN
  const apiKeyEnv = process.env.ANTHROPIC_API_KEY
  const hasAuth = !!(authToken || apiKeyEnv)

  if (!hasAuth) {
    result.hasApiKey = false
    const msg = 'No authentication found. Set ANTHROPIC_API_KEY (for API key auth) or ANTHROPIC_AUTH_TOKEN (for Claude Pro subscriber auth) in ~/.claude/settings.json env field.'
    result.errors.push(msg)
    log('ERROR', msg)
    log('WARN', 'Sidecar will start but API calls will fail without valid authentication.')
  } else if (authToken) {
    // 使用 auth_token（Bearer 认证）
    const maskedToken = authToken.slice(0, 8) + '...'
    log('INFO', `Auth token detected: ${maskedToken}, source: ANTHROPIC_AUTH_TOKEN, mode: Bearer`)
  } else if (apiKeyEnv) {
    // 使用 api_key（x-api-key 认证）
    const maskedKey = apiKeyEnv.slice(0, 8) + '...'
    log('INFO', `API key detected: ${maskedKey}, source: ANTHROPIC_API_KEY`)
  }

  // 打印关键配置状态（有助于验证 applyConfigEnvironmentVariables() 是否生效）
  log('INFO', `ANTHROPIC_BASE_URL: ${process.env.ANTHROPIC_BASE_URL ? process.env.ANTHROPIC_BASE_URL : '未设置（使用默认 Anthropic 端点）'}`)
  log('INFO', `ANTHROPIC_MODEL: ${process.env.ANTHROPIC_MODEL ?? '未设置（使用模型默认值）'}`)

  // 验证工作目录
  const cwd = agentConfig.cwd
  if (!cwd) {
    const msg = 'No working directory specified. Falling back to process.cwd().'
    result.warnings.push(msg)
    log('WARN', msg)
  } else {
    log('INFO', `Working directory: ${cwd}`)
  }

  // 验证权限模式
  const permMode = agentConfig.defaultPermissionMode
  if (permMode === 'auto-approve') {
    const msg = 'Permission mode is auto-approve: all tool calls will be approved without prompting.'
    result.warnings.push(msg)
    log('WARN', msg)
  }

  // 验证预算上限
  if (agentConfig.maxBudgetUsd !== undefined) {
    if (isNaN(agentConfig.maxBudgetUsd) || agentConfig.maxBudgetUsd <= 0) {
      const msg = `Invalid maxBudgetUsd value: ${agentConfig.maxBudgetUsd}. Budget limit will not be enforced.`
      result.warnings.push(msg)
      log('WARN', msg)
    } else {
      log('INFO', `Max budget: $${agentConfig.maxBudgetUsd} USD`)
    }
  }

  return result
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

  // 0. Force native file search in compiled sidecar binary.
  //    The embedded ripgrep in bun compiled binaries does not bundle a real rg executable;
  //    it would spawn the sidecar itself with argv0='rg', which silently fails or returns
  //    incomplete results. Native fs search (readdir) is reliable and avoids this issue.
  //    The Rust backend also sets this env var, but we set it here too to ensure it works
  //    when the sidecar binary is invoked directly (e.g. during testing or debugging).
  if (!process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH) {
    process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = 'true'
  }

  // 1. 先启用配置系统（必须在读取配置之前）
  enableConfigs()
  log('INFO', '配置系统已启用')

  // 2. 将 settings.json env 字段的变量注入到 process.env
  //    这样 ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 等 MiniMax/自定义端点配置才能生效
  applyConfigEnvironmentVariables()
  log('INFO', '已应用 settings.json env 字段到 process.env')

  // [DIAG] 详细环境变量诊断（在 applyConfigEnvironmentVariables 之后立即检查）
  log('INFO', `环境变量诊断:`)
  log('INFO', `  ANTHROPIC_BASE_URL: ${process.env.ANTHROPIC_BASE_URL || '未设置'}`)
  log('INFO', `  ANTHROPIC_AUTH_TOKEN: ${process.env.ANTHROPIC_AUTH_TOKEN ? '已设置(' + process.env.ANTHROPIC_AUTH_TOKEN.slice(0, 8) + '...)' : '未设置'}`)
  log('INFO', `  ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '已设置(' + process.env.ANTHROPIC_API_KEY.slice(0, 8) + '...)' : '未设置'}`)
  log('INFO', `  ANTHROPIC_MODEL: ${process.env.ANTHROPIC_MODEL || '未设置'}`)

  // 3. 读取配置（此时 process.env 已包含 settings.json env 的值）
  const { agentConfig, debug, permissionTimeoutMs, agentId } = readConfig()
  log('INFO', `Agent ID: ${agentId}`)
  log('INFO', `权限模式: ${agentConfig.defaultPermissionMode}`)
  log('INFO', `调试日志: ${debug}`)

  // 4. 配置验证（在 AgentCore 初始化之前校验关键参数）
  const configValidation = validateConfig(agentConfig)

  // 2. 初始化 SessionStorage
  let sessionStorage: SessionStorage | undefined
  if (agentConfig.persistSession !== false) {
    const sessionDir = join(homedir(), '.claude', 'sessions', agentId)
    log('INFO', `Session 存储目录: ${sessionDir}`)
    try {
      await mkdir(sessionDir, { recursive: true })
      sessionStorage = new SessionStorage(sessionDir)
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

    // 恢复上次保存的成本数据
    const restored = restoreCostStateForSession()
    if (restored) {
      log('INFO', '已恢复历史成本数据')
    } else {
      log('INFO', '无历史成本数据需要恢复')
    }
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
  // Cron 调度器引用（在 server.start() 后创建，在 gracefulShutdown 中停止）
  let cronScheduler: SidecarCronScheduler | null = null

  async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) return
    isShuttingDown = true

    log('INFO', `收到 ${signal} 信号，开始优雅关闭...`)

    try {
      // 4.0 停止 Cron 调度器
      if (cronScheduler) {
        cronScheduler.stop()
        log('INFO', 'Cron 调度器已停止')
      }

      // 4.1 停止 JsonRpcServer（中止所有流、拒绝待处理权限请求）
      await server.stop()
      log('INFO', 'JsonRpcServer 已停止')

      // 4.2 保存当前会话成本数据
      saveCurrentSessionCosts()
      log('INFO', '已保存当前会话成本数据')

      // 4.3 关闭 AgentCore（断开 MCP 连接等）
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

  // 6. 启动 Cron 调度器
  cronScheduler = new SidecarCronScheduler({
    readJobs,
    writeJobs,
    executeJob: async (jobId: string, jobName: string, instruction: string) => {
      log('INFO', `调度器触发任务: ${jobName} (${jobId})`)
      try {
        const generator = agentCore.execute(instruction)
        // 消费 generator 直至完成（调度器自己管理 run_count/lastRunAt）
        for await (const _event of generator) {
          // 忽略流事件，仅等待执行完成
        }
      } catch (err) {
        log('ERROR', `调度任务执行失败: ${jobName}:`, err instanceof Error ? err.message : String(err))
      }
    },
    sendNotification: (method: string, params: unknown) => server.sendNotification(method, params),
    log,
  })
  cronScheduler.start()
  // 将调度器注入 server，使 CRUD handler 可触发 refreshSchedule()
  server.setScheduler(cronScheduler)
  log('INFO', 'Cron 调度器已启动')

  // 输出就绪信号到 stdout（Tauri host 等待此消息确认 sidecar 已就绪）
  // 格式：JSON-RPC notification（不带 id）
  // 同时携带配置验证结果，让前端在启动阶段即可感知 API key 缺失等致命错误
  const readyNotification = JSON.stringify({
    jsonrpc: '2.0',
    method: '$/ready',
    params: {
      version: '1.0.0',
      cwd: agentConfig.cwd,
      permissionMode: agentConfig.defaultPermissionMode,
      hasApiKey: configValidation.hasApiKey,
      configErrors: configValidation.errors,
      configWarnings: configValidation.warnings,
    },
  })
  process.stdout.write(readyNotification + '\n')

  log('INFO', '已发送就绪信号，Sidecar 进程运行中')

  // ─── 内存监控（诊断内存泄漏）───────────────────────────────────────────────

  // 每60秒记录一次内存使用情况
  const memoryMonitorInterval = setInterval(() => {
    const memUsage = process.memoryUsage()
    const rssMB = (memUsage.rss / 1024 / 1024).toFixed(2)
    const heapUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2)
    const heapTotalMB = (memUsage.heapTotal / 1024 / 1024).toFixed(2)
    const externalMB = (memUsage.external / 1024 / 1024).toFixed(2)

    log('INFO', `内存使用: RSS=${rssMB}MB, Heap=${heapUsedMB}/${heapTotalMB}MB, External=${externalMB}MB`)

    // 分级内存管理响应
    if (memUsage.rss > 4 * 1024 * 1024 * 1024) {
      // 4GB: 记录日志后退出，触发宿主重启机制
      log('ERROR', `🔴 内存超过 4GB 阈值！RSS=${rssMB}MB，强制退出进程以触发宿主重启`)
      process.exit(1)
    } else if (memUsage.rss > 3 * 1024 * 1024 * 1024) {
      // 3GB: 发送 JSON-RPC notification 通知宿主
      log('WARN', `🟠 内存超过 3GB 阈值！RSS=${rssMB}MB，发送 memoryAlert 通知`)
      const alertNotification = JSON.stringify({
        jsonrpc: '2.0',
        method: '$/memoryAlert',
        params: { rssMB: parseFloat(rssMB), threshold: 3072 },
      })
      process.stdout.write(alertNotification + '\n')
    } else if (memUsage.rss > 2 * 1024 * 1024 * 1024) {
      // 2GB: 发出警告并尝试强制垃圾回收
      log('WARN', `⚠️  内存使用过高！RSS=${rssMB}MB，可能存在内存泄漏`)

      // 尝试强制垃圾回收（如果启用）
      if (global.gc) {
        log('INFO', '尝试强制垃圾回收...')
        global.gc()
        const afterGC = process.memoryUsage()
        const afterRSS = (afterGC.rss / 1024 / 1024).toFixed(2)
        log('INFO', `GC后内存: RSS=${afterRSS}MB`)
      } else {
        log('INFO', '未启用强制 GC（需使用 --expose-gc 标志启动）')
      }
    }
  }, 60_000)

  // 确保进程退出时清理监控
  process.on('exit', () => {
    clearInterval(memoryMonitorInterval)
    const finalMem = process.memoryUsage()
    const finalRSS = (finalMem.rss / 1024 / 1024).toFixed(2)
    log('INFO', `进程退出，最终内存使用: RSS=${finalRSS}MB`)
  })
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
