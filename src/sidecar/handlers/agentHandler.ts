/**
 * sidecar/handlers/agentHandler.ts
 *
 * Agent 管理 RPC handler。
 * 提供 10 个 RPC 方法：
 *   - getAgents             → 获取所有 Agent 配置
 *   - getAgent              → 获取单个 Agent 配置
 *   - createAgent           → 创建 Agent
 *   - updateAgent           → 更新 Agent
 *   - deleteAgent           → 删除 Agent
 *   - getAgentMemoryStats   → 获取 Agent 记忆统计
 *   - searchAgentMemory     → 全文搜索 Agent 记忆
 *   - getAgentMemoryRecent  → 获取最新记忆列表
 *   - clearAgentMemory      → 清空 Agent 记忆
 *
 * 数据存储：
 *   - ~/.claude-desktop/agents/{agentId}.json           → Agent 配置
 *   - ~/.claude-desktop/agents/{agentId}/memories.json  → Agent 记忆
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { homedir } from 'os'

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

export interface AgentConfig {
  id: string
  name: string
  description?: string
  systemPrompt?: string
  model?: string
  tools?: string[] // 允许使用的工具列表
  skills?: string[] // 关联的技能 ID
  createdAt: string
  updatedAt: string
  metadata?: Record<string, unknown>
}

export interface AgentMemoryEntry {
  id: string
  agentId: string
  content: string
  embedding?: number[]
  createdAt: string
  tags?: string[]
}

// ─── 服务接口 ─────────────────────────────────────────────────────────────────

interface ServerLike {
  registerMethod(name: string, handler: (params: any) => Promise<any>): void
}

// ─── 存储路径 ─────────────────────────────────────────────────────────────────

const AGENTS_DIR = join(homedir(), '.claude-desktop', 'agents')

/**
 * Agent 配置文件路径
 */
function agentConfigPath(agentId: string): string {
  return join(AGENTS_DIR, `${agentId}.json`)
}

/**
 * Agent 记忆目录路径
 */
function agentMemoryDir(agentId: string): string {
  return join(AGENTS_DIR, agentId)
}

/**
 * Agent 记忆文件路径
 */
function agentMemoryPath(agentId: string): string {
  return join(agentMemoryDir(agentId), 'memories.json')
}

// ─── 文件操作工具 ─────────────────────────────────────────────────────────────

/**
 * 确保 agents 目录存在
 */
async function ensureAgentsDir(): Promise<void> {
  await fs.mkdir(AGENTS_DIR, { recursive: true })
}

/**
 * 确保 Agent 记忆目录存在
 */
async function ensureAgentMemoryDir(agentId: string): Promise<void> {
  await fs.mkdir(agentMemoryDir(agentId), { recursive: true })
}

/**
 * 读取所有 Agent 配置（扫描 agents 目录中的 JSON 文件，排除子目录中的文件）
 */
async function readAllAgents(): Promise<AgentConfig[]> {
  try {
    await ensureAgentsDir()
    const entries = await fs.readdir(AGENTS_DIR, { withFileTypes: true })
    const agents: AgentConfig[] = []

    for (const entry of entries) {
      // 只读取直接子 JSON 文件（不递归，排除子目录）
      if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const content = await fs.readFile(join(AGENTS_DIR, entry.name), 'utf-8')
          const agent = JSON.parse(content) as AgentConfig
          agents.push(agent)
        } catch {
          // 单个文件读取失败不中断整体
        }
      }
    }

    return agents
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
}

/**
 * 读取单个 Agent 配置
 */
async function readAgent(agentId: string): Promise<AgentConfig | null> {
  try {
    const content = await fs.readFile(agentConfigPath(agentId), 'utf-8')
    return JSON.parse(content) as AgentConfig
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw err
  }
}

/**
 * 写入 Agent 配置
 */
async function writeAgent(agent: AgentConfig): Promise<void> {
  await ensureAgentsDir()
  await fs.writeFile(agentConfigPath(agent.id), JSON.stringify(agent, null, 2), 'utf-8')
}

/**
 * 读取 Agent 记忆列表
 */
async function readAgentMemories(agentId: string): Promise<AgentMemoryEntry[]> {
  try {
    const content = await fs.readFile(agentMemoryPath(agentId), 'utf-8')
    return JSON.parse(content) as AgentMemoryEntry[]
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
}

/**
 * 写入 Agent 记忆列表
 */
async function writeAgentMemories(agentId: string, memories: AgentMemoryEntry[]): Promise<void> {
  await ensureAgentMemoryDir(agentId)
  await fs.writeFile(agentMemoryPath(agentId), JSON.stringify(memories, null, 2), 'utf-8')
}

// ─── 方法实现 ─────────────────────────────────────────────────────────────────

/**
 * getAgents → 获取所有 Agent 配置
 */
async function getAgents(): Promise<{ agents: AgentConfig[] }> {
  const agents = await readAllAgents()
  // 按创建时间降序排列
  agents.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { agents }
}

/**
 * getAgent → 获取单个 Agent 配置
 */
async function getAgent(params: { id: string }): Promise<{ agent: AgentConfig | null }> {
  if (!params.id) {
    throw new Error('参数 id 不能为空')
  }
  const agent = await readAgent(params.id)
  return { agent }
}

/**
 * createAgent → 创建新 Agent
 */
async function createAgent(params: {
  name: string
  description?: string
  systemPrompt?: string
  model?: string
  tools?: string[]
  skills?: string[]
}): Promise<{ agent: AgentConfig }> {
  if (!params.name || typeof params.name !== 'string') {
    throw new Error('参数 name 不能为空')
  }

  const now = new Date().toISOString()
  const agent: AgentConfig = {
    id: randomUUID(),
    name: params.name,
    description: params.description,
    systemPrompt: params.systemPrompt,
    model: params.model,
    tools: params.tools ?? [],
    skills: params.skills ?? [],
    createdAt: now,
    updatedAt: now,
  }

  await writeAgent(agent)
  return { agent }
}

/**
 * updateAgent → 更新 Agent 配置
 */
async function updateAgent(params: {
  id: string
  name?: string
  description?: string
  systemPrompt?: string
  model?: string
  tools?: string[]
  skills?: string[]
}): Promise<{ agent: AgentConfig }> {
  if (!params.id) {
    throw new Error('参数 id 不能为空')
  }

  const existing = await readAgent(params.id)
  if (!existing) {
    throw new Error(`Agent 不存在: ${params.id}`)
  }

  const now = new Date().toISOString()
  const updated: AgentConfig = {
    ...existing,
    name: params.name !== undefined ? params.name : existing.name,
    description: params.description !== undefined ? params.description : existing.description,
    systemPrompt: params.systemPrompt !== undefined ? params.systemPrompt : existing.systemPrompt,
    model: params.model !== undefined ? params.model : existing.model,
    tools: params.tools !== undefined ? params.tools : existing.tools,
    skills: params.skills !== undefined ? params.skills : existing.skills,
    updatedAt: now,
  }

  await writeAgent(updated)
  return { agent: updated }
}

/**
 * deleteAgent → 删除 Agent
 */
async function deleteAgent(params: { id: string }): Promise<{ deleted: boolean }> {
  if (!params.id) {
    throw new Error('参数 id 不能为空')
  }

  try {
    await fs.unlink(agentConfigPath(params.id))
    // 同时尝试删除记忆目录（可选，忽略错误）
    try {
      await fs.rm(agentMemoryDir(params.id), { recursive: true, force: true })
    } catch {
      // 记忆目录删除失败不影响主要操作
    }
    return { deleted: true }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { deleted: false }
    }
    throw err
  }
}

/**
 * getAgentMemoryStats → 获取 Agent 记忆统计信息
 */
async function getAgentMemoryStats(params: { agentId: string }): Promise<{
  totalMemories: number
  oldestAt?: string
  newestAt?: string
}> {
  if (!params.agentId) {
    throw new Error('参数 agentId 不能为空')
  }

  const memories = await readAgentMemories(params.agentId)

  if (memories.length === 0) {
    return { totalMemories: 0 }
  }

  const sorted = [...memories].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  return {
    totalMemories: memories.length,
    oldestAt: sorted[0].createdAt,
    newestAt: sorted[sorted.length - 1].createdAt,
  }
}

/**
 * searchAgentMemory → 全文搜索 Agent 记忆（简单 contains 实现）
 */
async function searchAgentMemory(params: {
  agentId: string
  query: string
  limit?: number
}): Promise<{ memories: AgentMemoryEntry[] }> {
  if (!params.agentId) {
    throw new Error('参数 agentId 不能为空')
  }
  if (!params.query) {
    throw new Error('参数 query 不能为空')
  }

  const memories = await readAgentMemories(params.agentId)
  const queryLower = params.query.toLowerCase()

  let results = memories.filter(m => m.content.toLowerCase().includes(queryLower))

  // 按时间降序排列
  results.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const limit = params.limit && params.limit > 0 ? params.limit : 20
  results = results.slice(0, limit)

  return { memories: results }
}

/**
 * getAgentMemoryRecent → 获取最新记忆列表
 */
async function getAgentMemoryRecent(params: {
  agentId: string
  limit?: number
}): Promise<{ memories: AgentMemoryEntry[] }> {
  if (!params.agentId) {
    throw new Error('参数 agentId 不能为空')
  }

  const memories = await readAgentMemories(params.agentId)

  // 按时间降序排列
  memories.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const limit = params.limit && params.limit > 0 ? params.limit : 20
  const results = memories.slice(0, limit)

  return { memories: results }
}

/**
 * clearAgentMemory → 清空 Agent 所有记忆
 */
async function clearAgentMemory(params: { agentId: string }): Promise<{ cleared: number }> {
  if (!params.agentId) {
    throw new Error('参数 agentId 不能为空')
  }

  const memories = await readAgentMemories(params.agentId)
  const count = memories.length

  if (count > 0) {
    await writeAgentMemories(params.agentId, [])
  }

  return { cleared: count }
}

// ─── 注册函数 ─────────────────────────────────────────────────────────────────

/**
 * 注册所有 Agent 相关 RPC 方法到服务器实例。
 */
export function registerAgentHandlers(server: ServerLike): void {
  server.registerMethod('getAgents', async (_params: unknown) => {
    return getAgents()
  })

  server.registerMethod('getAgent', async (params: unknown) => {
    return getAgent(params as { id: string })
  })

  server.registerMethod('createAgent', async (params: unknown) => {
    return createAgent(
      params as {
        name: string
        description?: string
        systemPrompt?: string
        model?: string
        tools?: string[]
        skills?: string[]
      },
    )
  })

  server.registerMethod('updateAgent', async (params: unknown) => {
    return updateAgent(
      params as {
        id: string
        name?: string
        description?: string
        systemPrompt?: string
        model?: string
        tools?: string[]
        skills?: string[]
      },
    )
  })

  server.registerMethod('deleteAgent', async (params: unknown) => {
    return deleteAgent(params as { id: string })
  })

  server.registerMethod('getAgentMemoryStats', async (params: unknown) => {
    return getAgentMemoryStats(params as { agentId: string })
  })

  server.registerMethod('searchAgentMemory', async (params: unknown) => {
    return searchAgentMemory(params as { agentId: string; query: string; limit?: number })
  })

  server.registerMethod('getAgentMemoryRecent', async (params: unknown) => {
    return getAgentMemoryRecent(params as { agentId: string; limit?: number })
  })

  server.registerMethod('clearAgentMemory', async (params: unknown) => {
    return clearAgentMemory(params as { agentId: string })
  })
}
