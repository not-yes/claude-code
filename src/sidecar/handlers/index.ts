/**
 * sidecar/handlers/index.ts
 *
 * Handler 模块统一导出入口。
 * 每个 register 函数接收 JsonRpcServer 实例，向其注册对应的 RPC 方法。
 */

export { registerSessionHandlers } from './sessionHandler'
export { registerCheckpointHandlers } from './checkpointHandler'
export { registerCronHandlers } from './cronHandler'
export { registerAgentHandlers } from './agentHandler'
export { registerSkillHandlers } from './skillHandler'
export { registerMcpHandlers } from './mcpHandler'
