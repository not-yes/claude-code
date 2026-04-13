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
 * 数据来源：
 *   - 与 CLI 完全一致，使用 getAgentDefinitionsWithOverrides(cwd)
 *   - 聚合多源：built-in + plugin + custom（user/project/policy）
 *   - 支持 Markdown 格式（frontmatter + body）
 *   - 支持 JSON 格式（向后兼容）
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { homedir } from 'os'

// CLI Agent 加载系统
import {
  getAgentDefinitionsWithOverrides,
  clearAgentDefinitionsCache,
  type AgentDefinition,
  type AgentDefinitionsResult,
  isBuiltInAgent,
  isCustomAgent,
  isPluginAgent,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { getCwdState } from '../../bootstrap/state.js'
import { logError } from '../../utils/log.js'
import { logForDebugging } from '../../utils/debug.js'
import { loadMarkdownFilesForSubdir } from '../../utils/markdownConfigLoader.js'
import type { AgentCore } from '../../core/AgentCore.js'
import { readUnreadMessages } from '../../utils/teammateMailbox.js'

// ─── 内部存储类型定义 ─────────────────────────────────────────────────────────

/**
 * 内部存储的 AgentConfig 结构（向后兼容 JSON 格式）
 */
export interface AgentConfig {
  id: string
  name: string
  description?: string
  soul?: string             // system prompt / soul
  topology?: string         // react / dag / linear
  model?: string
  max_iterations?: number
  tools?: string[]          // 允许使用的工具列表
  skills?: string[]         // 关联的技能列表
  handoffs?: string[]       // 转交的 Agent 列表
  has_memory?: boolean
  memory?: {
    enabled: boolean
    memory_type: string
    persist: boolean
  }
  hitl?: {
    enabled: boolean
    strict_mode?: boolean
    before_tools?: boolean
  }
  createdAt: string
  updatedAt: string
  metadata?: Record<string, unknown>
}

/**
 * 统一 Agent 信息接口（用于内部处理）
 */
interface AgentInfo {
  name: string
  description: string
  model?: string
  tools?: string[]
  skills?: string[]
  memory?: string
  source: string
  sourceLabel: string
  file_path?: string
  system_prompt?: string
}

/**
 * 内部 Agent 记忆条目（存储结构）
 */
export interface AgentMemoryEntryStore {
  id: string
  agentId: string
  content: string
  importance?: number
  embedding?: number[]
  createdAt: string
  accessCount?: number
  tags?: string[]
}

// ─── 缓存机制 ─────────────────────────────────────────────────────────────────

let agentsCache: AgentInfo[] | null = null
let agentsCacheTime = 0
const AGENTS_CACHE_TTL = 5000 // 5秒缓存

/**
 * 清除 agents 缓存（在写操作后调用）
 */
export function clearAgentsCache(): void {
  agentsCache = null
  agentsCacheTime = 0
  // 同时清除底层 memoize 缓存，确保下次加载能读到磁盘最新数据
  clearAgentDefinitionsCache()
  loadMarkdownFilesForSubdir.cache.clear?.()
}

// ─── 前端 DTO 类型定义 ────────────────────────────────────────────────────────

interface AgentInfoDTO {
  name: string
  description?: string
  topology?: string
  skills?: string[]
  handoffs?: string[]
  has_memory?: boolean
}

interface AgentDetailDTO extends AgentInfoDTO {
  soul?: string
  memory?: {
    enabled: boolean
    memory_type: string
    persist: boolean
  }
  hitl?: {
    enabled: boolean
    strict_mode?: boolean
    before_tools?: boolean
  }
  model?: string
  max_iterations?: number
}

interface AgentMemoryEntryDTO {
  id: string
  content: string
  importance?: number
  created_at?: string
  access_count?: number
}

interface AgentMemoryStatsDTO {
  agent: string
  stats: {
    short_term_count: number
    long_term_count: number
    episodic_count: number
  }
}

// ─── 服务接口 ─────────────────────────────────────────────────────────────────

interface ServerLike {
  registerMethod(name: string, handler: (params: any) => Promise<any>): void
}

// ─── 存储路径（仅用于记忆文件和向后兼容） ───────────────────────────────────────

const AGENTS_DIR = join(homedir(), '.claude', 'agents')

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
 * 确保 Agent 记忆目录存在
 */
async function ensureAgentMemoryDir(agentId: string): Promise<void> {
  await fs.mkdir(agentMemoryDir(agentId), { recursive: true })
}

// ─── Agent 加载系统（与 CLI 一致） ─────────────────────────────────────────────

/**
 * 将 CLI AgentDefinition 转换为内部 AgentInfo 结构
 */
function agentDefinitionToInfo(agent: AgentDefinition): AgentInfo {
  // 获取 system prompt
  let systemPrompt = ''
  try {
    if (!isBuiltInAgent(agent)) {
      // Custom 和 Plugin agents 有无参 getSystemPrompt
      systemPrompt = agent.getSystemPrompt()
    }
    // Built-in agents 需要 toolUseContext，这里留空
  } catch {
    systemPrompt = ''
  }

  // 推断来源标签
  let sourceLabel = 'built-in'
  if (isCustomAgent(agent)) {
    if (agent.source === 'userSettings') sourceLabel = 'user'
    else if (agent.source === 'projectSettings') sourceLabel = 'project'
    else if (agent.source === 'policySettings') sourceLabel = 'managed'
    else if (agent.source === 'flagSettings') sourceLabel = 'flag'
    else sourceLabel = 'custom'
  } else if (isPluginAgent(agent)) {
    sourceLabel = 'plugin'
  }

  return {
    name: agent.agentType,
    description: agent.whenToUse || '',
    model: agent.model,
    tools: agent.tools,
    skills: agent.skills,
    memory: agent.memory,
    source: agent.source,
    sourceLabel,
    file_path: agent.baseDir || agent.filename || '',
    system_prompt: systemPrompt,
  }
}

/**
 * 加载所有 agents（与 CLI /agents 命令一致）
 * 注意：过滤掉内置 agents，保留插件、用户级、项目级、管理级 agents
 */
async function loadAllAgents(): Promise<AgentInfo[]> {
  const cwd = getCwdState() || process.cwd()
  logForDebugging(`[agentDiag] loadAllAgents START: cwd=${cwd}`)

  try {
    // 使用 CLI 的 agent 加载系统
    const result: AgentDefinitionsResult = await getAgentDefinitionsWithOverrides(cwd)

    // 调试日志：记录加载结果
    const totalCount = result.allAgents.length
    const builtInCount = result.allAgents.filter(a => isBuiltInAgent(a)).length
    const customCount = result.allAgents.filter(a => isCustomAgent(a)).length
    const pluginCount = result.allAgents.filter(a => isPluginAgent(a)).length
    logForDebugging(`[agentDiag] loadAllAgents: cwd=${cwd}, total=${totalCount}, built-in=${builtInCount}, custom=${customCount}, plugin=${pluginCount}`)

    // 打印每个 definition 的 source 信息
    for (const def of result.allAgents) {
      logForDebugging(`[agentDiag] agent raw: name=${def.agentType}, source=${def.source}`)
    }

    // 转换为 AgentInfo 数组
    const agents = result.allAgents.map(agentDefinitionToInfo)

    // 过滤掉内置和插件 agents，仅保留用户级、项目级、管理级
    const filteredAgents = agents.filter(agent =>
      agent.sourceLabel !== 'built-in' && agent.sourceLabel !== 'plugin'
    )

    logForDebugging(`[agentDiag] loadAllAgents: after filter=${filteredAgents.length}, names=[${filteredAgents.map(a => a.name).join(', ')}]`)

    // 按 name 去重（插件 < 用户 < 项目 < 管理）
    const seen = new Map<string, AgentInfo>()
    for (const agent of filteredAgents) {
      // 后面的会覆盖前面的（plugin < user < project < managed）
      seen.set(agent.name, agent)
    }

    const finalResult = Array.from(seen.values())
    logForDebugging(`[agentDiag] loadAllAgents DONE: final count=${finalResult.length}, names=[${finalResult.map(a => a.name).join(', ')}]`)

    return finalResult
  } catch (err) {
    logForDebugging(`[agentDiag] loadAllAgents FAILED: ${err instanceof Error ? err.message : String(err)}`)
    logError(err)
    return []
  }
}

/**
 * 读取所有 agents（带缓存）
 */
async function readAllAgents(): Promise<AgentInfo[]> {
  const now = Date.now()

  // 检查缓存
  if (agentsCache && (now - agentsCacheTime) < AGENTS_CACHE_TTL) {
    return agentsCache
  }

  // 缓存过期，清除底层 memoize 缓存以读取磁盘最新数据
  clearAgentDefinitionsCache()
  loadMarkdownFilesForSubdir.cache.clear?.()

  // 加载 agents
  agentsCache = await loadAllAgents()
  agentsCacheTime = now

  return agentsCache
}

/**
 * 按 name 查找单个 agent
 */
async function readAgentByName(name: string): Promise<AgentInfo | null> {
  const agents = await readAllAgents()
  return agents.find(a => a.name === name) || null
}

/**
 * 读取 Agent 记忆列表
 */
async function readAgentMemories(agentId: string): Promise<AgentMemoryEntryStore[]> {
  try {
    const content = await fs.readFile(agentMemoryPath(agentId), 'utf-8')
    return JSON.parse(content) as AgentMemoryEntryStore[]
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
async function writeAgentMemories(agentId: string, memories: AgentMemoryEntryStore[]): Promise<void> {
  await ensureAgentMemoryDir(agentId)
  await fs.writeFile(agentMemoryPath(agentId), JSON.stringify(memories, null, 2), 'utf-8')
}

// ─── DTO 转换 ─────────────────────────────────────────────────────────────────

/**
 * 将内部 AgentInfo 转换为前端 AgentInfo DTO
 */
function toAgentInfo(agent: AgentInfo): AgentInfoDTO {
  return {
    name: agent.name,
    description: agent.description,
    skills: agent.skills,
    has_memory: !!agent.memory,
  }
}

/**
 * 将内部 AgentInfo 转换为前端 AgentDetail DTO
 */
function toAgentDetail(agent: AgentInfo): AgentDetailDTO {
  return {
    name: agent.name,
    description: agent.description,
    skills: agent.skills,
    has_memory: !!agent.memory,
    soul: agent.system_prompt,
    model: agent.model,
  }
}

/**
 * 将内部记忆条目转换为前端 DTO
 */
function toMemoryEntryDTO(m: AgentMemoryEntryStore): AgentMemoryEntryDTO {
  return {
    id: m.id,
    content: m.content,
    importance: m.importance,
    created_at: m.createdAt,
    access_count: m.accessCount,
  }
}

// ─── 方法实现 ─────────────────────────────────────────────────────────────────

/**
 * getAgents → 获取所有 Agent 配置，返回 AgentInfo[]
 */
async function getAgents(): Promise<AgentInfoDTO[]> {
  const agents = await readAllAgents()
  // 按名称排序
  agents.sort((a, b) => a.name.localeCompare(b.name))
  return agents.map(toAgentInfo)
}

/**
 * getAgent → 获取单个 Agent 详情（按 name 查找）
 */
async function getAgent(params: { name: string }): Promise<AgentDetailDTO> {
  if (!params.name) {
    throw new Error('参数 name 不能为空')
  }
  const agent = await readAgentByName(params.name)
  if (!agent) {
    throw new Error(`Agent 不存在: ${params.name}`)
  }
  return toAgentDetail(agent)
}

/**
 * createAgent → 创建新 Agent，返回 {name}
 * 创建 Markdown 格式的 Agent 文件（与 CLI 一致）
 */
async function createAgent(params: {
  name: string
  soul?: string
  description?: string
  skills?: string[]
  handoffs?: string[]
  model?: string
  tools?: string[]
  memory?: string
}): Promise<{ name: string }> {
  if (!params.name || typeof params.name !== 'string') {
    throw new Error('参数 name 不能为空')
  }

  // 在用户级 agents 目录创建 Markdown 文件
  const userAgentsDir = join(homedir(), '.claude', 'agents')
  await fs.mkdir(userAgentsDir, { recursive: true })

  const agentFileName = `${params.name}.md`
  const agentFilePath = join(userAgentsDir, agentFileName)

  // 构建 Markdown 内容（frontmatter + body）
  const frontmatter = [
    '---',
    `name: ${params.name}`,
    `description: ${params.description || ''}`,
  ]

  if (params.model) {
    frontmatter.push(`model: ${params.model}`)
  }

  if (params.tools && params.tools.length > 0) {
    frontmatter.push('tools:')
    params.tools.forEach(tool => {
      frontmatter.push(`  - ${tool}`)
    })
  }

  if (params.skills && params.skills.length > 0) {
    frontmatter.push('skills:')
    params.skills.forEach(skill => {
      frontmatter.push(`  - ${skill}`)
    })
  }

  if (params.memory) {
    frontmatter.push(`memory: ${params.memory}`)
  }

  frontmatter.push('---')
  frontmatter.push('')

  // system prompt 作为 body
  const body = params.soul || `# ${params.name}\n\n${params.description || ''}`
  frontmatter.push(body)

  await fs.writeFile(agentFilePath, frontmatter.join('\n'), 'utf-8')

  // 清除缓存
  clearAgentsCache()

  return { name: params.name }
}

/**
 * updateAgent → 更新 Agent 配置（按 name 查找），返回 void
 * 注意：只能更新用户级自定义 agents，不能更新 built-in/plugin agents
 */
async function updateAgent(params: {
  name: string
  soul?: string
  description?: string
  skills?: string[]
  handoffs?: string[]
  model?: string
  max_iterations?: number
  topology?: string
  tools?: string[]
  memory?: string
}): Promise<void> {
  if (!params.name) {
    throw new Error('参数 name 不能为空')
  }

  const agent = await readAgentByName(params.name)
  if (!agent) {
    throw new Error(`Agent 不存在: ${params.name}`)
  }

  // 检查是否为用户级 agent（只有用户级的才能更新）
  if (agent.sourceLabel !== 'user' && agent.sourceLabel !== 'project') {
    throw new Error(`无法更新 ${agent.sourceLabel} 级 agent: ${params.name}`)
  }

  // 在用户级 agents 目录更新 Markdown 文件
  const userAgentsDir = join(homedir(), '.claude', 'agents')
  const agentFileName = `${params.name}.md`
  const agentFilePath = join(userAgentsDir, agentFileName)

  // 读取现有文件（保留未更新的字段）
  let existingContent = ''
  try {
    existingContent = await fs.readFile(agentFilePath, 'utf-8')
  } catch {
    // 如果文件不存在，使用默认值
  }

  // 构建新的 Markdown 内容
  const frontmatter = [
    '---',
    `name: ${params.name}`,
    `description: ${params.description || agent.description || ''}`,
  ]

  if (params.model || agent.model) {
    frontmatter.push(`model: ${params.model || agent.model || ''}`)
  }

  const tools = params.tools || agent.tools
  if (tools && tools.length > 0) {
    frontmatter.push('tools:')
    tools.forEach(tool => {
      frontmatter.push(`  - ${tool}`)
    })
  }

  const skills = params.skills || agent.skills
  if (skills && skills.length > 0) {
    frontmatter.push('skills:')
    skills.forEach(skill => {
      frontmatter.push(`  - ${skill}`)
    })
  }

  const memory = params.memory || agent.memory
  if (memory) {
    frontmatter.push(`memory: ${memory}`)
  }

  frontmatter.push('---')
  frontmatter.push('')

  // system prompt 作为 body
  const body = params.soul || agent.system_prompt || `# ${params.name}\n\n${params.description || agent.description || ''}`
  frontmatter.push(body)

  await fs.writeFile(agentFilePath, frontmatter.join('\n'), 'utf-8')

  // 清除缓存
  clearAgentsCache()
}

/**
 * deleteAgent → 删除 Agent（按 name 查找），返回 void
 * 注意：只能删除用户级自定义 agents
 */
async function deleteAgent(params: { name: string }): Promise<void> {
  if (!params.name) {
    throw new Error('参数 name 不能为空')
  }

  const agent = await readAgentByName(params.name)
  if (!agent) {
    throw new Error(`Agent 不存在: ${params.name}`)
  }

  // 检查是否为用户级 agent（只有用户级的才能删除）
  if (agent.sourceLabel !== 'user' && agent.sourceLabel !== 'project') {
    throw new Error(`无法删除 ${agent.sourceLabel} 级 agent: ${params.name}`)
  }

  // 删除 Markdown 文件
  const userAgentsDir = join(homedir(), '.claude', 'agents')
  const agentFilePath = join(userAgentsDir, `${params.name}.md`)

  try {
    await fs.unlink(agentFilePath)

    // 同时尝试删除记忆目录（可选，忽略错误）
    try {
      await fs.rm(agentMemoryDir(params.name), { recursive: true, force: true })
    } catch {
      // 记忆目录删除失败不影响主要操作
    }

    // 清除缓存
    clearAgentsCache()
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }
}

/**
 * getAgentMemoryStats → 获取 Agent 记忆统计信息（按 name 查找）
 */
async function getAgentMemoryStats(params: { name: string }): Promise<AgentMemoryStatsDTO> {
  if (!params.name) {
    throw new Error('参数 name 不能为空')
  }

  const agent = await readAgentByName(params.name)
  if (!agent) {
    throw new Error(`Agent 不存在: ${params.name}`)
  }

  const memories = await readAgentMemories(params.name)

  return {
    agent: params.name,
    stats: {
      short_term_count: memories.length,
      long_term_count: 0,
      episodic_count: 0,
    },
  }
}

/**
 * searchAgentMemory → 全文搜索 Agent 记忆（简单 contains 实现）
 */
async function searchAgentMemory(params: {
  name: string
  q: string
  limit?: number
}): Promise<{ agent: string; query: string; results: AgentMemoryEntryDTO[] }> {
  if (!params.name) {
    throw new Error('参数 name 不能为空')
  }
  if (!params.q) {
    throw new Error('参数 q 不能为空')
  }

  const agent = await readAgentByName(params.name)
  if (!agent) {
    throw new Error(`Agent 不存在: ${params.name}`)
  }

  const memories = await readAgentMemories(params.name)
  const queryLower = params.q.toLowerCase()

  let results = memories.filter(m => m.content.toLowerCase().includes(queryLower))

  // 按时间降序排列
  results.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const limit = params.limit && params.limit > 0 ? params.limit : 20
  results = results.slice(0, limit)

  return {
    agent: params.name,
    query: params.q,
    results: results.map(toMemoryEntryDTO),
  }
}

/**
 * getAgentMemoryRecent → 获取最新记忆列表
 */
async function getAgentMemoryRecent(params: {
  name: string
  limit?: number
}): Promise<{ agent: string; results: AgentMemoryEntryDTO[] }> {
  if (!params.name) {
    throw new Error('参数 name 不能为空')
  }

  const agent = await readAgentByName(params.name)
  if (!agent) {
    throw new Error(`Agent 不存在: ${params.name}`)
  }

  const memories = await readAgentMemories(params.name)

  // 按时间降序排列
  memories.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const limit = params.limit && params.limit > 0 ? params.limit : 20
  const results = memories.slice(0, limit)

  return {
    agent: params.name,
    results: results.map(toMemoryEntryDTO),
  }
}

/**
 * clearAgentMemory → 清空 Agent 所有记忆，返回 void
 */
async function clearAgentMemory(params: { name: string }): Promise<void> {
  if (!params.name) {
    throw new Error('参数 name 不能为空')
  }

  const agent = await readAgentByName(params.name)
  if (!agent) {
    throw new Error(`Agent 不存在: ${params.name}`)
  }

  const memories = await readAgentMemories(params.name)
  if (memories.length > 0) {
    await writeAgentMemories(params.name, [])
  }
}

// ─── 注册函数 ─────────────────────────────────────────────────────────────────

/**
 * 注册所有 Agent 相关 RPC 方法到服务器实例。
 */
export function registerAgentHandlers(server: ServerLike, agentCore: AgentCore): void {
  server.registerMethod('getAgents', async (_params: unknown) => {
    return getAgents()
  })

  server.registerMethod('getAgent', async (params: unknown) => {
    return getAgent(params as { name: string })
  })

  server.registerMethod('createAgent', async (params: unknown) => {
    const result = await createAgent(params as {
      name: string
      soul?: string
      description?: string
      skills?: string[]
      handoffs?: string[]
    })
    agentCore.invalidateAgentCache()
    return result
  })

  server.registerMethod('updateAgent', async (params: unknown) => {
    const p = params as {
      name: string
      soul?: string
      description?: string
      skills?: string[]
      handoffs?: string[]
      model?: string
      max_iterations?: number
      topology?: string
    }
    await updateAgent(p)
    agentCore.invalidateAgentCache(p.name)
  })

  server.registerMethod('deleteAgent', async (params: unknown) => {
    const p = params as { name: string }
    await deleteAgent(p)
    agentCore.invalidateAgentCache(p.name)
  })

  server.registerMethod('getAgentMemoryStats', async (params: unknown) => {
    return getAgentMemoryStats(params as { name: string })
  })

  server.registerMethod('searchAgentMemory', async (params: unknown) => {
    return searchAgentMemory(params as { name: string; q: string; limit?: number })
  })

  server.registerMethod('getAgentMemoryRecent', async (params: unknown) => {
    return getAgentMemoryRecent(params as { name: string; limit?: number })
  })

  server.registerMethod('clearAgentMemory', async (params: unknown) => {
    return clearAgentMemory(params as { name: string })
  })

  server.registerMethod('getUnreadCounts', async (_params: unknown) => {
    const agents = await readAllAgents()

    const entries = await Promise.all(
      agents.map(async (agent) => {
        try {
          const unread = await readUnreadMessages(agent.name)
          return [agent.name, unread.length] as const
        } catch {
          return [agent.name, 0] as const
        }
      })
    )

    return Object.fromEntries(entries) as Record<string, number>
  })
}
