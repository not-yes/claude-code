/**
 * sidecar/index.ts
 *
 * Sidecar 模块的 barrel export。
 *
 * 统一导出 Sidecar 各子模块的公共 API，
 * 外部代码通过 `import { ... } from './sidecar'` 使用。
 */

// ─── JsonRpcServer（核心服务）─────────────────────────────────────────────────
export { JsonRpcServer } from './jsonRpcServer'
export type { JsonRpcServerOptions } from './jsonRpcServer'

// ─── StreamHandler（流式处理）────────────────────────────────────────────────
export {
  StreamHandler,
  ActiveStreamRegistry,
  createBackpressureWriter,
  createSyncWriter,
} from './streamHandler'
export type { StreamHandlerOptions, StreamResult } from './streamHandler'

// ─── PermissionBridge（权限桥接）─────────────────────────────────────────────
export { PermissionBridge } from './permissionBridge'

// ─── 入口函数（可从外部调用启动 Sidecar）─────────────────────────────────────
export { startSidecar } from './entry'
