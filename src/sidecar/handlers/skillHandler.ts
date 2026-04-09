/**
 * sidecar/handlers/skillHandler.ts
 *
 * Skill（技皃）管理 RPC handler。
 * 提供 7 个 RPC 方法：
 *   - getSkills          → 获取所有技能（与 CLI /skills 命令一致）
 *   - getSkill           → 获取单个技能详情
 *   - createSkill        → 创建技能
 *   - installSkill       → 安装技能（本地或远程）
 *   - updateSkill        → 更新技能
 *   - deleteSkill        → 删除技能
 *   - searchRemoteSkills → 搜索远程技能（暂返回空数组）
 *
 * 数据来源：
 *   - 使用 CLI 的 commands 系统（getCommands/getSkillDirCommands 等）
 *   - 与 CLI 交互层 `/skills` 命令显示的数据完全一致
 *   - 包括：skillDirCommands、bundledSkills、pluginSkills、dynamicSkills 等
 */

import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  getSkillDirCommands,
  getDynamicSkills,
} from '../../skills/loadSkillsDir.js'
import { getBundledSkills } from '../../skills/bundledSkills.js'
import { getPluginSkills } from '../../utils/plugins/loadPluginCommands.js'
import { getBuiltinPluginSkillCommands } from '../../plugins/builtinPlugins.js'
import type { Command, CommandBase, PromptCommand } from '../../types/command.js'
import { getCwdState } from '../../bootstrap/state.js'
import type { AgentCore } from '../../core/AgentCore.js'

// ─── 内部 Skill 结构（从 Command 转换）────────────────────────────────────

/**
 * 内部存储的 Skill 结构（统一格式）
 */
export interface Skill {
  id: string
  name: string
  description: string
  category: string
  version: string
  guidance: string           // 技能指导内容（Markdown）
  trigger_patterns: string[] // 触发模式
  suggested_tools: string[]  // 建议工具列表
  suggested_action?: string  // 建议动作
  source: string             // 来源：local | remote | bundled | plugin | mcp
  file_path: string          // 文件路径
  installed: boolean
  loadedFrom?: string        // 加载来源标识
  scripts?: { name: string; file: string; description: string }[]
  createdAt: string
  updatedAt: string
}

// ─── 前端 DTO 类型定义 ────────────────────────────────────────────────────────

interface SkillInfoDTO {
  name: string
  description: string
  category: string
  version: string
  trigger_patterns: string[]
  suggested_tools: string[]
  source: string
  file_path?: string
  installed?: boolean
}

interface SkillDetailDTO extends SkillInfoDTO {
  file_path: string
  guidance: string
  suggested_action?: string
  scripts?: { name: string; file: string; description: string }[]
}

interface RemoteSkillItemDTO {
  id: string
  name: string
  description: string
  source: string
  installed: boolean
  install_command: string
}

// ─── 服务接口 ─────────────────────────────────────────────────────────────────

interface ServerLike {
  registerMethod(name: string, handler: (params: unknown) => Promise<unknown>): void
}

// ─── 缓存 ─────────────────────────────────────────────────────────────────────

// Skills 缓存（避免重复加载）
let skillsCache: Skill[] | null = null
let skillsCacheTime = 0
const SKILLS_CACHE_TTL = 5000 // 5秒缓存

/**
 * 清除 skills 缓存（供外部调用）
 */
export function clearSkillsCache(): void {
  skillsCache = null
  skillsCacheTime = 0
}

// ─── 从 Command 转换为 Skill ────────────────────────────────────────────────

/**
 * 将 CLI Command (PromptCommand) 转换为内部 Skill 结构
 */
function commandToSkill(cmd: Command): Skill {
  const now = new Date().toISOString()
  const pc = cmd as PromptCommand & CommandBase

  // 从 source 和 loadedFrom 推断 category
  const category = inferCategory(cmd)

  return {
    id: cmd.name,
    name: cmd.name,
    description: cmd.description || '',
    category,
    version: cmd.version || '1.0.0',
    guidance: '', // guidance 需要异步加载，在 getSkill 中处理
    trigger_patterns: [], // commands 系统没有这个字段
    suggested_tools: pc.allowedTools || [],
    source: inferSource(cmd),
    file_path: pc.skillRoot || '',
    installed: true,
    loadedFrom: cmd.loadedFrom,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 推断 skill 分类
 */
function inferCategory(cmd: Command): string {
  if (cmd.loadedFrom === 'mcp') return 'mcp'
  if (cmd.loadedFrom === 'plugin') return 'plugin'
  if (cmd.loadedFrom === 'bundled') return 'bundled'
  const src = (cmd as PromptCommand).source
  if (src === 'policySettings') return 'managed'
  if (src === 'userSettings') return 'user'
  if (src === 'projectSettings') return 'project'
  return 'general'
}

/**
 * 推断 skill 来源
 */
function inferSource(cmd: Command): string {
  if (cmd.loadedFrom === 'mcp') return 'mcp'
  if (cmd.loadedFrom === 'plugin') return 'plugin'
  if (cmd.loadedFrom === 'bundled') return 'bundled'
  return 'local'
}

/**
 * 加载所有 skills（与 CLI /skills 命令一致）
 */
async function loadAllSkills(): Promise<Skill[]> {
  const cwd = getCwdState() || process.cwd()

  try {
    // 并行加载所有来源的 skills
    const [
      skillDirCommands,
      pluginSkills,
      bundledSkills,
      builtinPluginSkills,
      dynamicSkills,
    ] = await Promise.all([
      getSkillDirCommands(cwd).catch(err => {
        logError('skillDirCommands 加载失败', err)
        return []
      }),
      getPluginSkills().catch(err => {
        logError('pluginSkills 加载失败', err)
        return []
      }),
      Promise.resolve(getBundledSkills()),
      Promise.resolve(getBuiltinPluginSkillCommands()),
      Promise.resolve(getDynamicSkills()),
    ])

    // 合并所有 skills
    const allCommands: Command[] = [
      ...bundledSkills,
      ...builtinPluginSkills,
      ...skillDirCommands,
      ...pluginSkills,
      ...dynamicSkills,
    ]

    // 过滤出 prompt 类型的 commands（即 skills）
    const promptCommands = allCommands.filter(
      (cmd): cmd is Command => cmd.type === 'prompt'
    )

    // 去重（按 name）
    const seen = new Set<string>()
    const uniqueCommands = promptCommands.filter(cmd => {
      if (seen.has(cmd.name)) return false
      seen.add(cmd.name)
      return true
    })

    // 转换为 Skill 结构
    const skills = uniqueCommands.map(commandToSkill)

    logInfo(`加载了 ${skills.length} 个 skills`)
    return skills
  } catch (err) {
    logError('loadAllSkills 失败', err)
    return []
  }
}

/**
 * 读取所有技能配置（带缓存）
 */
async function readAllSkills(): Promise<Skill[]> {
  const now = Date.now()

  // 检查缓存
  if (skillsCache && (now - skillsCacheTime) < SKILLS_CACHE_TTL) {
    return skillsCache
  }

  // 加载 skills
  skillsCache = await loadAllSkills()
  skillsCacheTime = now

  return skillsCache
}

/**
 * 按 name 查找技能
 */
async function readSkillByName(name: string): Promise<Skill | null> {
  const skills = await readAllSkills()
  return skills.find(s => s.name === name) ?? null
}

// ─── 日志工具 ─────────────────────────────────────────────────────────────────

function logInfo(...args: unknown[]): void {
  const timestamp = new Date().toISOString()
  process.stderr.write(`[${timestamp}] [INFO] [skillHandler] ${args.join(' ')}\n`)
}

function logError(msg: string, err: unknown): void {
  const timestamp = new Date().toISOString()
  const errMsg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`[${timestamp}] [ERROR] [skillHandler] ${msg}: ${errMsg}\n`)
}

// ─── DTO 转换 ─────────────────────────────────────────────────────────────────

/**
 * 将内部 Skill 转换为前端 SkillInfo DTO
 */
function toSkillInfo(skill: Skill): SkillInfoDTO {
  return {
    name: skill.name,
    description: skill.description,
    category: skill.category,
    version: skill.version,
    trigger_patterns: skill.trigger_patterns,
    suggested_tools: skill.suggested_tools,
    source: skill.source,
    file_path: skill.file_path,
    installed: skill.installed,
  }
}

/**
 * 将内部 Skill 转换为前端 SkillDetail DTO
 */
function toSkillDetail(skill: Skill): SkillDetailDTO {
  return {
    name: skill.name,
    description: skill.description,
    category: skill.category,
    version: skill.version,
    trigger_patterns: skill.trigger_patterns,
    suggested_tools: skill.suggested_tools,
    source: skill.source,
    file_path: skill.file_path,
    installed: skill.installed,
    guidance: skill.guidance,
    suggested_action: skill.suggested_action,
    scripts: skill.scripts,
  }
}

// ─── 方法实现 ─────────────────────────────────────────────────────────────────

/**
 * getSkills → 获取所有技能，返回 SkillInfo[]
 */
async function getSkills(): Promise<SkillInfoDTO[]> {
  const skills = await readAllSkills()
  // 按 name 排序
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills.map(toSkillInfo)
}

/**
 * getSkill → 获取单个技能详情（按 name 查找），返回 SkillDetail
 * 注意：对于 file-based skills，需要读取 SKILL.md 文件内容作为 guidance
 */
async function getSkill(params: { name: string }): Promise<SkillDetailDTO> {
  if (!params.name) {
    throw new Error('参数 name 不能为空')
  }

  const skill = await readSkillByName(params.name)
  if (!skill) {
    throw new Error(`技能不存在: ${params.name}`)
  }

  // 如果有 file_path 且是目录格式，尝试读取 SKILL.md 内容
  let guidance = skill.guidance
  if (skill.file_path && !guidance) {
    try {
      const skillMdPath = skill.file_path.endsWith('.md')
        ? skill.file_path
        : join(skill.file_path, 'SKILL.md')

      const content = await fs.readFile(skillMdPath, 'utf-8')
      // 解析 frontmatter 后的 body 部分
      const bodyMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/)
      guidance = bodyMatch ? bodyMatch[1].trim() : content
    } catch {
      // 读取失败，使用空 guidance
      guidance = ''
    }
  }

  return {
    ...toSkillDetail(skill),
    guidance,
  }
}

/**
 * createSkill → 创建新技能，返回 SkillInfo
 * 注意：这会创建一个新的 skill 文件到用户 skills 目录
 */
async function createSkill(params: {
  name: string
  description?: string
  category?: string
  guidance?: string
  trigger_patterns?: string[]
  suggested_tools?: string[]
}): Promise<SkillInfoDTO> {
  if (!params.name || typeof params.name !== 'string') {
    throw new Error('参数 name 不能为空')
  }

  const userSkillsDir = join(homedir(), '.claude', 'skills', params.name)
  const skillMdPath = join(userSkillsDir, 'SKILL.md')

  // 创建目录
  await fs.mkdir(userSkillsDir, { recursive: true })

  // 构建 SKILL.md 内容
  const frontmatter = [
    '---',
    `name: ${params.name}`,
    `description: ${params.description || ''}`,
    `category: ${params.category || 'general'}`,
    'version: 1.0.0',
    params.trigger_patterns && params.trigger_patterns.length > 0
      ? `trigger_patterns: [${params.trigger_patterns.join(', ')}]`
      : '',
    params.suggested_tools && params.suggested_tools.length > 0
      ? `tool_whitelist: [${params.suggested_tools.join(', ')}]`
      : '',
    '---',
    '',
    params.guidance || `# ${params.name}\n\n${params.description || ''}`,
  ].filter(line => line !== '').join('\n')

  // 写入文件
  await fs.writeFile(skillMdPath, frontmatter, 'utf-8')

  // 清除缓存
  clearSkillsCache()

  const now = new Date().toISOString()
  const skill: Skill = {
    id: params.name,
    name: params.name,
    description: params.description ?? '',
    category: params.category ?? 'general',
    version: '1.0.0',
    guidance: params.guidance ?? '',
    trigger_patterns: params.trigger_patterns ?? [],
    suggested_tools: params.suggested_tools ?? [],
    source: 'local',
    file_path: skillMdPath,
    installed: true,
    createdAt: now,
    updatedAt: now,
  }

  return toSkillInfo(skill)
}

/**
 * installSkill → 安装技能（按 skill_id 或远程 source）
 * 返回 SkillInfo
 */
async function installSkill(params: {
  skill_id: string
  source?: string
}): Promise<SkillInfoDTO> {
  if (!params.skill_id) {
    throw new Error('参数 skill_id 不能为空')
  }

  // 查找已有技能
  const existing = await readSkillByName(params.skill_id)

  if (!existing) {
    throw new Error(`技能不存在: ${params.skill_id}`)
  }

  const now = new Date().toISOString()
  const updated: Skill = {
    ...existing,
    installed: true,
    updatedAt: now,
  }

  // 清除缓存
  clearSkillsCache()

  return toSkillInfo(updated)
}

/**
 * updateSkill → 更新技能（按 name 查找），返回 SkillDetail
 * 注意：这会更新 SKILL.md 文件内容
 */
async function updateSkill(params: {
  name: string
  description?: string
  category?: string
  guidance?: string
  trigger_patterns?: string[]
  suggested_tools?: string[]
  suggested_action?: string
}): Promise<SkillDetailDTO> {
  if (!params.name) {
    throw new Error('参数 name 不能为空')
  }

  const existing = await readSkillByName(params.name)
  if (!existing) {
    throw new Error(`技能不存在: ${params.name}`)
  }

  // 如果有 file_path，更新 SKILL.md 文件
  if (existing.file_path) {
    try {
      const skillMdPath = existing.file_path.endsWith('.md')
        ? existing.file_path
        : join(existing.file_path, 'SKILL.md')

      // 读取现有内容
      const content = await fs.readFile(skillMdPath, 'utf-8')

      // 解析并更新 frontmatter
      const frontmatterMatch = content.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/)

      if (frontmatterMatch) {
        // 有 frontmatter，更新它
        let [, frontmatter, body] = frontmatterMatch

        // 更新 frontmatter 中的字段
        if (params.description !== undefined) {
          frontmatter = frontmatter.replace(
            /(description:\s*).*/,
            `$1${params.description}`
          )
        }
        if (params.category !== undefined) {
          frontmatter = frontmatter.replace(
            /(category:\s*).*/,
            `$1${params.category}`
          )
        }

        // 更新 body（guidance）
        if (params.guidance !== undefined) {
          body = params.guidance
        }

        await fs.writeFile(skillMdPath, frontmatter + body, 'utf-8')
      } else {
        // 没有 frontmatter，创建新的
        const newContent = [
          '---',
          `name: ${existing.name}`,
          `description: ${params.description ?? existing.description}`,
          `category: ${params.category ?? existing.category}`,
          `version: ${existing.version}`,
          '---',
          '',
          params.guidance ?? existing.guidance,
        ].join('\n')

        await fs.writeFile(skillMdPath, newContent, 'utf-8')
      }
    } catch (err) {
      logError('更新 SKILL.md 文件失败', err)
      // 文件更新失败不阻断返回
    }
  }

  const now = new Date().toISOString()
  const updated: Skill = {
    ...existing,
    description: params.description !== undefined ? params.description : existing.description,
    category: params.category !== undefined ? params.category : existing.category,
    guidance: params.guidance !== undefined ? params.guidance : existing.guidance,
    trigger_patterns: params.trigger_patterns !== undefined ? params.trigger_patterns : existing.trigger_patterns,
    suggested_tools: params.suggested_tools !== undefined ? params.suggested_tools : existing.suggested_tools,
    suggested_action: params.suggested_action !== undefined ? params.suggested_action : existing.suggested_action,
    updatedAt: now,
  }

  // 清除缓存
  clearSkillsCache()

  return toSkillDetail(updated)
}

/**
 * deleteSkill → 删除技能（按 name 查找），返回 void
 * 注意：这会删除 SKILL.md 文件或目录
 */
async function deleteSkill(params: { name: string }): Promise<void> {
  if (!params.name) {
    throw new Error('参数 name 不能为空')
  }

  const existing = await readSkillByName(params.name)
  if (!existing) {
    throw new Error(`技能不存在: ${params.name}`)
  }

  // 删除文件/目录
  if (existing.file_path) {
    try {
      const targetPath = existing.file_path.endsWith('SKILL.md')
        ? existing.file_path.replace(/SKILL\.md$/, '')
        : existing.file_path

      // 检查是否是目录
      const stat = await fs.stat(targetPath)
      if (stat.isDirectory()) {
        // 递归删除目录
        await fs.rm(targetPath, { recursive: true, force: true })
      } else {
        // 删除文件
        await fs.unlink(targetPath)
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (!errMsg.includes('ENOENT')) {
        throw err
      }
    }
  }

  // 清除缓存
  clearSkillsCache()
}

/**
 * searchRemoteSkills → 搜索远程技能市场，返回 RemoteSkillItem[]
 * 当前实现：返回空数组（远程市场功能待实现）
 */
async function searchRemoteSkills(params: {
  q: string
  limit?: number
  source?: string
}): Promise<RemoteSkillItemDTO[]> {
  // TODO: 远程技能市场集成后在此实现 HTTP 搜索请求
  void params
  return []
}

// ─── 注册函数 ─────────────────────────────────────────────────────────────────

/**
 * 注册所有 Skill 相关 RPC 方法到服务器实例。
 */
export function registerSkillHandlers(server: ServerLike, agentCore: AgentCore): void {
  server.registerMethod('getSkills', async (_params: unknown) => {
    return getSkills()
  })

  server.registerMethod('getSkill', async (params: unknown) => {
    return getSkill(params as { name: string })
  })

  server.registerMethod('createSkill', async (params: unknown) => {
    const result = await createSkill(params as {
      name: string
      description?: string
      category?: string
      guidance?: string
      trigger_patterns?: string[]
      suggested_tools?: string[]
    })
    agentCore.invalidateSkillCache()
    return result
  })

  server.registerMethod('installSkill', async (params: unknown) => {
    return installSkill(params as { skill_id: string; source?: string })
  })

  server.registerMethod('updateSkill', async (params: unknown) => {
    const result = await updateSkill(params as {
      name: string
      description?: string
      category?: string
      guidance?: string
      trigger_patterns?: string[]
      suggested_tools?: string[]
      suggested_action?: string
    })
    agentCore.invalidateSkillCache()
    return result
  })

  server.registerMethod('deleteSkill', async (params: unknown) => {
    await deleteSkill(params as { name: string })
    agentCore.invalidateSkillCache()
  })

  server.registerMethod('searchRemoteSkills', async (params: unknown) => {
    return searchRemoteSkills(params as { q: string; limit?: number; source?: string })
  })
}
