/**
 * sidecar/handlers/mcpHandler.ts
 *
 * MCP（Model Context Protocol）服务器管理 RPC handler。
 * 提供 4 个 RPC 方法：
 *   - listMcpServers    → 列出所有已配置的 MCP 服务器及其状态
 *   - getMcpStatus      → 获取 MCP 连接状态汇总
 *   - connectMcpServer  → 动态连接 MCP 服务器（框架，待后续实现）
 *   - disconnectMcpServer → 断开 MCP 服务器连接（框架，待后续实现）
 *
 * 数据来源：
 *   - 通过 AgentCore.getMcpClients() 获取当前 MCP 客户端列表
 */

import type { AgentCore } from '../../core/AgentCore.js'

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

interface McpServerInfo {
  name: string
  uri: string
  status: 'connected' | 'disconnected' | 'error'
  tools?: string[]
}

// ─── 服务接口 ─────────────────────────────────────────────────────────────────

interface ServerLike {
  registerMethod(name: string, handler: (params: any) => Promise<any>): void
}

// ─── 注册函数 ─────────────────────────────────────────────────────────────────

/**
 * 注册所有 MCP 相关 RPC 方法到服务器实例。
 */
export function registerMcpHandlers(server: ServerLike, agentCore: AgentCore): void {
  // 列出 MCP 服务器
  server.registerMethod('listMcpServers', async (): Promise<{ servers: McpServerInfo[] }> => {
    try {
      const clients = agentCore.getMcpClients()
      const servers: McpServerInfo[] = clients.map((client: any) => ({
        name: client.name ?? client.serverName ?? 'unknown',
        uri: client.uri ?? client.url ?? '',
        status: client.isConnected?.() ? 'connected' : 'disconnected',
        tools: client.getTools?.()?.map((t: any) => t.name) ?? [],
      }))
      return { servers }
    } catch {
      return { servers: [] }
    }
  })

  // 查询 MCP 状态
  server.registerMethod('getMcpStatus', async (): Promise<{ connected: number; total: number; servers: McpServerInfo[] }> => {
    try {
      const clients = agentCore.getMcpClients()
      const servers: McpServerInfo[] = clients.map((client: any) => ({
        name: client.name ?? client.serverName ?? 'unknown',
        uri: client.uri ?? client.url ?? '',
        status: client.isConnected?.() ? 'connected' : 'disconnected',
      }))
      const connected = servers.filter(s => s.status === 'connected').length
      return { connected, total: servers.length, servers }
    } catch {
      return { connected: 0, total: 0, servers: [] }
    }
  })

  // 动态连接 MCP 服务器（框架，实际连接逻辑待后续实现）
  server.registerMethod('connectMcpServer', async (_params: unknown): Promise<{ success: boolean; error?: string }> => {
    // TODO: 实际连接逻辑需要 MCP 客户端初始化支持
    return { success: false, error: 'Dynamic MCP connection not yet implemented' }
  })

  // 断开 MCP 服务器连接（框架）
  server.registerMethod('disconnectMcpServer', async (_params: unknown): Promise<{ success: boolean; error?: string }> => {
    // TODO: 实际断开逻辑需要 MCP 客户端管理支持
    return { success: false, error: 'Dynamic MCP disconnection not yet implemented' }
  })
}
