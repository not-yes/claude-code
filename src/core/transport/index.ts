/**
 * core/transport/index.ts
 *
 * Transport 模块的统一导出和工厂函数。
 *
 * 使用方式：
 * ```typescript
 * // 方式一：自动根据环境选择（推荐）
 * import { createTransport } from './core/transport';
 * const transport = await createTransport();
 * await transport.initialize();
 *
 * // 方式二：手动选择实现
 * import { DirectTransport } from './core/transport';
 * import { createAgentCore } from './core/AgentCore';
 * const agentCore = await createAgentCore({ cwd: process.cwd() });
 * const transport = new DirectTransport(agentCore);
 *
 * // 方式三：Sidecar 模式
 * import { JsonRpcTransport } from './core/transport';
 * const transport = new JsonRpcTransport(process.stdin, process.stdout);
 * ```
 *
 * 环境变量控制：
 *   SIDECAR_MODE=true   → 使用 JsonRpcTransport（通过 stdin/stdout 通信）
 *   CLAUDE_CWD          → AgentCore 的工作目录（DirectTransport 模式下使用）
 *   CLAUDE_API_KEY      → API 密钥（覆盖 ANTHROPIC_API_KEY）
 *   CLAUDE_PERMISSION   → 默认权限模式（auto-approve/interactive/plan-only/deny-all）
 */

// ─── 公开接口导出 ──────────────────────────────────────────────────────────────

export type { Transport } from './Transport.js'
export { DirectTransport } from './DirectTransport.js'
export { JsonRpcTransport } from './JsonRpcTransport.js'

// ─── 工厂函数 ──────────────────────────────────────────────────────────────────

import type { Transport } from './Transport.js'
import type { CorePermissionMode } from '../types.js'

/**
 * 根据环境自动选择并创建 Transport 实现。
 *
 * 决策逻辑：
 * 1. 如果环境变量 SIDECAR_MODE=true → 返回 JsonRpcTransport（stdin/stdout 通信）
 * 2. 否则 → 返回 DirectTransport（直接调用 AgentCore，CLI 模式）
 *
 * 工厂函数只负责创建，不调用 initialize()。
 * 调用方应在获取 Transport 后手动调用 initialize()，
 * 以便在初始化前注册权限回调等。
 *
 * @returns 未初始化的 Transport 实例
 */
export async function createTransport(): Promise<Transport> {
  const isSidecar = process.env['SIDECAR_MODE'] === 'true'

  if (isSidecar) {
    // ─── Sidecar 模式：通过 stdin/stdout 通信 ─────────────────────────────
    // 使用动态 import 保持模块懒加载
    const { JsonRpcTransport } = await import('./JsonRpcTransport.js')

    // 从环境变量读取背压配置
    const maxQueueSize = process.env['SIDECAR_MAX_QUEUE_SIZE']
      ? parseInt(process.env['SIDECAR_MAX_QUEUE_SIZE'], 10)
      : undefined

    return new JsonRpcTransport(process.stdin, process.stdout, {
      maxQueueSize,
    })
  } else {
    // ─── CLI 模式：直接调用 AgentCore ─────────────────────────────────────
    const { createAgentCore } = await import('../AgentCore.js')
    const { DirectTransport } = await import('./DirectTransport.js')

    // 从环境变量读取配置
    const cwd = process.env['CLAUDE_CWD'] ?? process.cwd()
    const apiKey = process.env['CLAUDE_API_KEY'] ?? process.env['ANTHROPIC_API_KEY']
    const permissionModeStr = process.env['CLAUDE_PERMISSION'] ?? 'interactive'

    // 验证权限模式
    const validModes: CorePermissionMode[] = ['auto-approve', 'interactive', 'plan-only', 'deny-all']
    const defaultPermissionMode: CorePermissionMode = validModes.includes(
      permissionModeStr as CorePermissionMode,
    )
      ? (permissionModeStr as CorePermissionMode)
      : 'interactive'

    // 创建 AgentCore 实例
    const agentCore = await createAgentCore({
      cwd,
      apiKey,
      defaultPermissionMode,
      persistSession: true,
    })

    return new DirectTransport(agentCore)
  }
}

/**
 * 创建并初始化 Transport 的便捷函数。
 *
 * 相比 createTransport()，此函数会自动调用 initialize()。
 * 适合不需要在初始化前注册权限回调的简单场景。
 *
 * @param permissionHandler 可选的权限请求回调（在 initialize 前注册）
 * @returns 已初始化的 Transport 实例
 */
export async function createAndInitTransport(
  permissionHandler?: (
    request: import('../types.js').PermissionRequest,
  ) => Promise<import('../types.js').PermissionDecision>,
): Promise<Transport> {
  const transport = await createTransport()

  // 在 initialize 前注册权限回调（避免初始化期间的权限请求丢失）
  if (permissionHandler) {
    transport.onPermissionRequest(permissionHandler)
  }

  await transport.initialize()
  return transport
}
