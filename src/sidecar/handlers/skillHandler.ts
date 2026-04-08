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
 *   - ~/.claude-desktop/skills/{skillId}.json → 技能配置（含 content）
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { homedir } from 'os'

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

export interface Skill {
  id: string
  name: string
  description?: string
  version: string
  author?: string
  content: string // 技能定义内容（Markdown）
  isInstalled: boolean
  installedAt?: string
  source?: 'local' | 'remote'
  remoteUrl?: string
  createdAt: string
  updatedAt: string
}

// ─── 服务接口 ─────────────────────────────────────────────────────────────────

interface ServerLike {
  registerMethod(name: string, handler: (params: any) => Promise<any>): void
}

// ─── 存储路径 ─────────────────────────────────────────────────────────────────

const SKILLS_DIR = join(homedir(), '.claude-desktop', 'skills')

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
 * 读取单个技能配置
 */
async function readSkill(skillId: string): Promise<Skill | null> {
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
 * 写入技能配置
 */
async function writeSkill(skill: Skill): Promise<void> {
  await ensureSkillsDir()
  await fs.writeFile(skillFilePath(skill.id), JSON.stringify(skill, null, 2), 'utf-8')
}

// ─── 方法实现 ─────────────────────────────────────────────────────────────────

/**
 * getSkills → 获取所有技能
 */
async function getSkills(): Promise<{ skills: Skill[] }> {
  const skills = await readAllSkills()
  // 按创建时间降序排列
  skills.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { skills }
}

/**
 * getSkill → 获取单个技能
 */
async function getSkill(params: { id: string }): Promise<{ skill: Skill | null }> {
  if (!params.id) {
    throw new Error('参数 id 不能为空')
  }
  const skill = await readSkill(params.id)
  return { skill }
}

/**
 * createSkill → 创建新技能
 */
async function createSkill(params: {
  name: string
  description?: string
  content: string
  version?: string
}): Promise<{ skill: Skill }> {
  if (!params.name || typeof params.name !== 'string') {
    throw new Error('参数 name 不能为空')
  }
  if (!params.content || typeof params.content !== 'string') {
    throw new Error('参数 content 不能为空')
  }

  const now = new Date().toISOString()
  const skill: Skill = {
    id: randomUUID(),
    name: params.name,
    description: params.description,
    version: params.version ?? '1.0.0',
    content: params.content,
    isInstalled: false,
    source: 'local',
    createdAt: now,
    updatedAt: now,
  }

  await writeSkill(skill)
  return { skill }
}

/**
 * installSkill → 安装技能
 * - 如果提供 id：将已有技能标记为已安装
 * - 如果提供 remoteUrl：从远端安装（当前实现为标记 source='remote'）
 */
async function installSkill(params: {
  id?: string
  remoteUrl?: string
}): Promise<{ skill: Skill }> {
  if (!params.id && !params.remoteUrl) {
    throw new Error('参数 id 或 remoteUrl 至少提供一个')
  }

  const now = new Date().toISOString()

  if (params.remoteUrl) {
    // 远程安装：标记 source='remote'，content 暂用 URL 占位
    // 实际远程市场集成后可在此处发起 HTTP 请求拉取内容
    const skill: Skill = {
      id: randomUUID(),
      name: params.remoteUrl.split('/').pop() ?? 'remote-skill',
      version: '1.0.0',
      content: `# Remote Skill\n\nSource: ${params.remoteUrl}\n`,
      isInstalled: true,
      installedAt: now,
      source: 'remote',
      remoteUrl: params.remoteUrl,
      createdAt: now,
      updatedAt: now,
    }
    await writeSkill(skill)
    return { skill }
  }

  // 本地安装：找到已有技能并标记 isInstalled=true
  const existing = await readSkill(params.id!)
  if (!existing) {
    throw new Error(`技能不存在: ${params.id}`)
  }

  const updated: Skill = {
    ...existing,
    isInstalled: true,
    installedAt: now,
    updatedAt: now,
  }

  await writeSkill(updated)
  return { skill: updated }
}

/**
 * updateSkill → 更新技能
 */
async function updateSkill(params: {
  id: string
  name?: string
  description?: string
  content?: string
  version?: string
}): Promise<{ skill: Skill }> {
  if (!params.id) {
    throw new Error('参数 id 不能为空')
  }

  const existing = await readSkill(params.id)
  if (!existing) {
    throw new Error(`技能不存在: ${params.id}`)
  }

  const now = new Date().toISOString()
  const updated: Skill = {
    ...existing,
    name: params.name !== undefined ? params.name : existing.name,
    description: params.description !== undefined ? params.description : existing.description,
    content: params.content !== undefined ? params.content : existing.content,
    version: params.version !== undefined ? params.version : existing.version,
    updatedAt: now,
  }

  await writeSkill(updated)
  return { skill: updated }
}

/**
 * deleteSkill → 删除技能
 */
async function deleteSkill(params: { id: string }): Promise<{ deleted: boolean }> {
  if (!params.id) {
    throw new Error('参数 id 不能为空')
  }

  try {
    await fs.unlink(skillFilePath(params.id))
    return { deleted: true }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { deleted: false }
    }
    throw err
  }
}

/**
 * searchRemoteSkills → 搜索远程技能市场
 * 当前实现：返回空数组（远程市场功能待实现）
 */
async function searchRemoteSkills(params: {
  query: string
  limit?: number
}): Promise<{ skills: Skill[] }> {
  // TODO: 远程技能市场集成后在此实现 HTTP 搜索请求
  void params
  return { skills: [] }
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
    return getSkill(params as { id: string })
  })

  server.registerMethod('createSkill', async (params: unknown) => {
    return createSkill(
      params as {
        name: string
        description?: string
        content: string
        version?: string
      },
    )
  })

  server.registerMethod('installSkill', async (params: unknown) => {
    return installSkill(params as { id?: string; remoteUrl?: string })
  })

  server.registerMethod('updateSkill', async (params: unknown) => {
    return updateSkill(
      params as {
        id: string
        name?: string
        description?: string
        content?: string
        version?: string
      },
    )
  })

  server.registerMethod('deleteSkill', async (params: unknown) => {
    return deleteSkill(params as { id: string })
  })

  server.registerMethod('searchRemoteSkills', async (params: unknown) => {
    return searchRemoteSkills(params as { query: string; limit?: number })
  })
}
