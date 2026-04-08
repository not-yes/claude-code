/**
 * sidecar/handlers/cronHandler.ts
 *
 * Cron 任务管理 RPC handler。
 * 提供 6 个 RPC 方法：
 *   - getCronJobs      → 获取所有 Cron 任务
 *   - addCronJob       → 添加 Cron 任务
 *   - updateCronJob    → 更新 Cron 任务
 *   - deleteCronJob    → 删除 Cron 任务
 *   - runCronJob       → 立即执行 Cron 任务（异步）
 *   - getCronHistory   → 获取执行历史
 *
 * 数据存储：
 *   - ~/.claude-desktop/cron/jobs.json    → 任务列表
 *   - ~/.claude-desktop/cron/history.json → 执行历史
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { homedir } from 'os'

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

export interface CronJob {
  id: string
  name: string
  schedule: string // cron 表达式
  command: string // 要执行的命令/提示
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  nextRunAt?: string
}

export interface CronHistoryEntry {
  id: string
  jobId: string
  startedAt: string
  completedAt?: string
  status: 'success' | 'failure' | 'running'
  output?: string
  error?: string
}

// ─── 服务接口（最小化依赖，避免循环引用） ────────────────────────────────────

interface AgentCoreLike {
  execute(content: string, options?: Record<string, unknown>): AsyncGenerator<unknown>
}

interface ServerLike {
  registerMethod(name: string, handler: (params: any) => Promise<any>): void
  getAgentCore(): AgentCoreLike
}

// ─── 存储路径 ─────────────────────────────────────────────────────────────────

const CRON_DIR = join(homedir(), '.claude-desktop', 'cron')
const JOBS_FILE = join(CRON_DIR, 'jobs.json')
const HISTORY_FILE = join(CRON_DIR, 'history.json')

// ─── 文件操作工具 ─────────────────────────────────────────────────────────────

/**
 * 确保存储目录存在
 */
async function ensureDir(): Promise<void> {
  await fs.mkdir(CRON_DIR, { recursive: true })
}

/**
 * 读取任务列表
 */
async function readJobs(): Promise<CronJob[]> {
  try {
    await ensureDir()
    const content = await fs.readFile(JOBS_FILE, 'utf-8')
    return JSON.parse(content) as CronJob[]
  } catch (err: unknown) {
    // 文件不存在时返回空数组
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
}

/**
 * 写入任务列表
 */
async function writeJobs(jobs: CronJob[]): Promise<void> {
  await ensureDir()
  await fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2), 'utf-8')
}

/**
 * 读取执行历史
 */
async function readHistory(): Promise<CronHistoryEntry[]> {
  try {
    await ensureDir()
    const content = await fs.readFile(HISTORY_FILE, 'utf-8')
    return JSON.parse(content) as CronHistoryEntry[]
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
}

/**
 * 写入执行历史
 */
async function writeHistory(history: CronHistoryEntry[]): Promise<void> {
  await ensureDir()
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8')
}

// ─── 方法实现 ─────────────────────────────────────────────────────────────────

/**
 * getCronJobs → 获取所有 Cron 任务
 */
async function getCronJobs(): Promise<{ jobs: CronJob[] }> {
  const jobs = await readJobs()
  return { jobs }
}

/**
 * addCronJob → 添加新的 Cron 任务
 */
async function addCronJob(params: {
  name: string
  schedule: string
  command: string
}): Promise<{ job: CronJob }> {
  if (!params.name || typeof params.name !== 'string') {
    throw new Error('参数 name 不能为空')
  }
  if (!params.schedule || typeof params.schedule !== 'string') {
    throw new Error('参数 schedule 不能为空')
  }
  if (!params.command || typeof params.command !== 'string') {
    throw new Error('参数 command 不能为空')
  }

  const jobs = await readJobs()
  const now = new Date().toISOString()

  const job: CronJob = {
    id: randomUUID(),
    name: params.name,
    schedule: params.schedule,
    command: params.command,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }

  jobs.push(job)
  await writeJobs(jobs)

  return { job }
}

/**
 * updateCronJob → 更新 Cron 任务
 */
async function updateCronJob(params: {
  id: string
  name?: string
  schedule?: string
  command?: string
  enabled?: boolean
}): Promise<{ job: CronJob }> {
  if (!params.id) {
    throw new Error('参数 id 不能为空')
  }

  const jobs = await readJobs()
  const idx = jobs.findIndex(j => j.id === params.id)

  if (idx === -1) {
    throw new Error(`Cron 任务不存在: ${params.id}`)
  }

  const existing = jobs[idx]
  const now = new Date().toISOString()

  const updated: CronJob = {
    ...existing,
    name: params.name !== undefined ? params.name : existing.name,
    schedule: params.schedule !== undefined ? params.schedule : existing.schedule,
    command: params.command !== undefined ? params.command : existing.command,
    enabled: params.enabled !== undefined ? params.enabled : existing.enabled,
    updatedAt: now,
  }

  jobs[idx] = updated
  await writeJobs(jobs)

  return { job: updated }
}

/**
 * deleteCronJob → 删除 Cron 任务
 */
async function deleteCronJob(params: { id: string }): Promise<{ deleted: boolean }> {
  if (!params.id) {
    throw new Error('参数 id 不能为空')
  }

  const jobs = await readJobs()
  const idx = jobs.findIndex(j => j.id === params.id)

  if (idx === -1) {
    return { deleted: false }
  }

  jobs.splice(idx, 1)
  await writeJobs(jobs)

  return { deleted: true }
}

/**
 * runCronJob → 立即执行指定 Cron 任务（异步）
 */
async function runCronJob(
  params: { id: string },
  agentCore: AgentCoreLike,
): Promise<{ historyId: string; status: 'started' }> {
  if (!params.id) {
    throw new Error('参数 id 不能为空')
  }

  const jobs = await readJobs()
  const job = jobs.find(j => j.id === params.id)

  if (!job) {
    throw new Error(`Cron 任务不存在: ${params.id}`)
  }

  if (!job.enabled) {
    throw new Error(`Cron 任务已禁用: ${params.id}`)
  }

  const historyId = randomUUID()
  const now = new Date().toISOString()

  // 写入运行中状态
  const history = await readHistory()
  const entry: CronHistoryEntry = {
    id: historyId,
    jobId: params.id,
    startedAt: now,
    status: 'running',
  }
  history.push(entry)
  await writeHistory(history)

  // 更新任务的 lastRunAt
  const jobIdx = jobs.findIndex(j => j.id === params.id)
  if (jobIdx !== -1) {
    jobs[jobIdx].lastRunAt = now
    jobs[jobIdx].updatedAt = now
    await writeJobs(jobs)
  }

  // 异步执行（不阻塞 RPC 响应）
  executeJobAsync(historyId, params.id, job.command, agentCore).catch(() => {
    // 错误已在 executeJobAsync 内部捕获并写入历史
  })

  return { historyId, status: 'started' }
}

/**
 * 异步执行 Cron 任务的实际逻辑
 */
async function executeJobAsync(
  historyId: string,
  jobId: string,
  command: string,
  agentCore: AgentCoreLike,
): Promise<void> {
  const outputChunks: string[] = []
  let completedAt: string
  let status: 'success' | 'failure' = 'success'
  let errorMsg: string | undefined

  try {
    const generator = agentCore.execute(command)
    for await (const event of generator) {
      const e = event as { type?: string; content?: string; message?: string }
      if (e.type === 'text' && e.content) {
        outputChunks.push(e.content)
      } else if (e.type === 'error') {
        status = 'failure'
        errorMsg = e.message ?? '未知错误'
      }
    }
  } catch (err: unknown) {
    status = 'failure'
    errorMsg = err instanceof Error ? err.message : String(err)
  }

  completedAt = new Date().toISOString()

  // 更新历史记录
  try {
    const history = await readHistory()
    const idx = history.findIndex(h => h.id === historyId)
    if (idx !== -1) {
      history[idx] = {
        ...history[idx],
        completedAt,
        status,
        output: outputChunks.join('') || undefined,
        error: errorMsg,
      }
      await writeHistory(history)
    }
  } catch {
    // 历史写入失败不影响任务执行结果
  }
}

/**
 * getCronHistory → 获取执行历史
 */
async function getCronHistory(params: {
  jobId?: string
  limit?: number
}): Promise<{ history: CronHistoryEntry[] }> {
  let history = await readHistory()

  // 按 jobId 过滤
  if (params.jobId) {
    history = history.filter(h => h.jobId === params.jobId)
  }

  // 按时间降序排列（最新在前）
  history.sort((a, b) => b.startedAt.localeCompare(a.startedAt))

  // 限制数量
  const limit = params.limit && params.limit > 0 ? params.limit : 100
  history = history.slice(0, limit)

  return { history }
}

// ─── 注册函数 ─────────────────────────────────────────────────────────────────

/**
 * 注册所有 Cron 相关 RPC 方法到服务器实例。
 */
export function registerCronHandlers(server: ServerLike): void {
  server.registerMethod('getCronJobs', async (_params: unknown) => {
    return getCronJobs()
  })

  server.registerMethod('addCronJob', async (params: unknown) => {
    return addCronJob(params as { name: string; schedule: string; command: string })
  })

  server.registerMethod('updateCronJob', async (params: unknown) => {
    return updateCronJob(
      params as { id: string; name?: string; schedule?: string; command?: string; enabled?: boolean },
    )
  })

  server.registerMethod('deleteCronJob', async (params: unknown) => {
    return deleteCronJob(params as { id: string })
  })

  server.registerMethod('runCronJob', async (params: unknown) => {
    return runCronJob(params as { id: string }, server.getAgentCore())
  })

  server.registerMethod('getCronHistory', async (params: unknown) => {
    return getCronHistory(params as { jobId?: string; limit?: number })
  })
}
