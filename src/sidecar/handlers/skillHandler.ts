/**
 * sidecar/handlers/skillHandler.ts
 *
 * Skill（技能）管理 RPC handler。
 * 提供 7 个 RPC 方法：
 *   - getSkills          → 获取所有技能
 *   - getSkill           → 获取单个技能
 *   - createSkill        → 创建技能
 *   - installSkill       → 安装技能（本地或远程）
 *   - updateSkill        → 更新技能
 *   - deleteSkill        → 删除技能
 *   - searchRemoteSkills → 搜索远程技能（暂返回空数组）
 *
 * 数据存储：
 *   - ~/.claude/skills/{skillId}.json → 技能配置（含 content）
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { homedir } from 'os'

// ─── 内部存储类型定义 ─────────────────────────────────────────────────────────

/**
 * 内部存储的 Skill 结构
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
  source: string             // 来源：'local' | 'remote' | url
  file_path: string          // 文件路径
  installed: boolean
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
  registerMethod(name: string, handler: (params: any) => Promise<any>): void
}

// ─── 存储路径 ─────────────────────────────────────────────────────────────────

const SKILLS_DIR = join(homedir(), '.claude', 'skills')

/**
 * 技能配置文件路径
 */
function skillFilePath(skillId: string): string {
  return join(SKILLS_DIR, `${skillId}.json`)
}

// ─── 文件操作工具 ─────────────────────────────────────────────────────────────

/**
 * 确保 skills 目录存在
 */
async function ensureSkillsDir(): Promise<void> {
  await fs.mkdir(SKILLS_DIR, { recursive: true })
}

/**
 * 读取所有技能配置（扫描 skills 目录中的 JSON 文件）
 */
async function readAllSkills(): Promise<Skill[]> {
  try {
    await ensureSkillsDir()
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true })
    const skills: Skill[] = []

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const content = await fs.readFile(join(SKILLS_DIR, entry.name), 'utf-8')
          const skill = JSON.parse(content) as Skill
          skills.push(skill)
        } catch {
          // 单个文件读取失败不中断整体
        }
      }
    }

    return skills
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
}

/**
 * 读取单个技能配置（按 ID）
 */
async function readSkillById(skillId: string): Promise<Skill | null> {
  try {
    const content = await fs.readFile(skillFilePath(skillId), 'utf-8')
    return JSON.parse(content) as Skill
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw err
  }
}

/**
 * 按 name 查找技能（遍历所有技能）
 */
async function readSkillByName(name: string): Promise<Skill | null> {
  const skills = await readAllSkills()
  return skills.find(s => s.name === name) ?? null
}

/**
 * 写入技能配置
 */
async function writeSkill(skill: Skill): Promise<void> {
  await ensureSkillsDir()
  await fs.writeFile(skillFilePath(skill.id), JSON.stringify(skill, null, 2), 'utf-8')
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
  // 按创建时间降序排列
  skills.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return skills.map(toSkillInfo)
}

/**
 * getSkill → 获取单个技能详情（按 name 查找），返回 SkillDetail
 */
async function getSkill(params: { name: string }): Promise<SkillDetailDTO> {
  if (!params.name) {
    throw new Error('参数 name 不能为空')
  }
  const skill = await readSkillByName(params.name)
  if (!skill) {
    throw new Error(`技能不存在: ${params.name}`)
  }
  return toSkillDetail(skill)
}

/**
 * createSkill → 创建新技能，返回 SkillInfo
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

  const now = new Date().toISOString()
  const id = randomUUID()
  const filePath = skillFilePath(id)

  const skill: Skill = {
    id,
    name: params.name,
    description: params.description ?? '',
    category: params.category ?? 'general',
    version: '1.0.0',
    guidance: params.guidance ?? '',
    trigger_patterns: params.trigger_patterns ?? [],
    suggested_tools: params.suggested_tools ?? [],
    source: 'local',
    file_path: filePath,
    installed: false,
    createdAt: now,
    updatedAt: now,
  }

  await writeSkill(skill)
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

  const now = new Date().toISOString()

  // 尝试按 ID 查找已有技能
  let existing = await readSkillById(params.skill_id)

  if (!existing && params.source) {
    // 远程安装：创建新技能记录
    const id = randomUUID()
    const filePath = skillFilePath(id)
    const skill: Skill = {
      id,
      name: params.skill_id,
      description: `从 ${params.source} 安装的远程技能`,
      category: 'remote',
      version: '1.0.0',
      guidance: '',
      trigger_patterns: [],
      suggested_tools: [],
      source: params.source,
      file_path: filePath,
      installed: true,
      createdAt: now,
      updatedAt: now,
    }
    await writeSkill(skill)
    return toSkillInfo(skill)
  }

  if (!existing) {
    // 也尝试按 name 查找
    existing = await readSkillByName(params.skill_id)
  }

  if (!existing) {
    throw new Error(`技能不存在: ${params.skill_id}`)
  }

  const updated: Skill = {
    ...existing,
    installed: true,
    updatedAt: now,
  }

  await writeSkill(updated)
  return toSkillInfo(updated)
}

/**
 * updateSkill → 更新技能（按 name 查找），返回 SkillDetail
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

  await writeSkill(updated)
  return toSkillDetail(updated)
}

/**
 * deleteSkill → 删除技能（按 name 查找），返回 void
 */
async function deleteSkill(params: { name: string }): Promise<void> {
  if (!params.name) {
    throw new Error('参数 name 不能为空')
  }

  const existing = await readSkillByName(params.name)
  if (!existing) {
    throw new Error(`技能不存在: ${params.name}`)
  }

  try {
    await fs.unlink(skillFilePath(existing.id))
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }
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
export function registerSkillHandlers(server: ServerLike): void {
  server.registerMethod('getSkills', async (_params: unknown) => {
    return getSkills()
  })

  server.registerMethod('getSkill', async (params: unknown) => {
    return getSkill(params as { name: string })
  })

  server.registerMethod('createSkill', async (params: unknown) => {
    return createSkill(params as {
      name: string
      description?: string
      category?: string
      guidance?: string
      trigger_patterns?: string[]
      suggested_tools?: string[]
    })
  })

  server.registerMethod('installSkill', async (params: unknown) => {
    return installSkill(params as { skill_id: string; source?: string })
  })

  server.registerMethod('updateSkill', async (params: unknown) => {
    return updateSkill(params as {
      name: string
      description?: string
      category?: string
      guidance?: string
      trigger_patterns?: string[]
      suggested_tools?: string[]
      suggested_action?: string
    })
  })

  server.registerMethod('deleteSkill', async (params: unknown) => {
    return deleteSkill(params as { name: string })
  })

  server.registerMethod('searchRemoteSkills', async (params: unknown) => {
    return searchRemoteSkills(params as { q: string; limit?: number; source?: string })
  })
}
