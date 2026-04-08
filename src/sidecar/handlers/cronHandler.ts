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
 *   - ~/.claude/cron/jobs.json    → 任务列表
 *   - ~/.claude/cron/history.json → 执行历史
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { homedir } from 'os'

// ─── 内部存储类型定义 ─────────────────────────────────────────────────────────

/**
 * 内部存储的 CronJob 结构（完整字段集）
 */
export interface CronJobStore {
  id: string
  name: string
  schedule: string
  schedule_type: 'cron' | 'at' | 'every'
  instruction: string
  enabled: boolean
  run_count: number
  createdAt: string
  updatedAt: string
  lastRunAt?: number   // Unix timestamp (ms)
  nextRunAt?: number   // Unix timestamp (ms)
  last_result?: {
    success: boolean
    output: string
    error?: string
    duration_ms: number
  }
}

/**
 * 内部历史记录结构
 */
export interface CronHistoryEntry {
  run_id: string
  job_id: string
  success: boolean
  output: string
  error?: string
  duration_ms: number
  timestamp: number  // Unix timestamp (ms)
}

// ─── 前端 DTO 类型定义 ────────────────────────────────────────────────────────

/**
 * 前端 CronJob DTO（与 tauri-api.ts 完全对齐）
 */
interface CronJobDTO {
  id: string
  name: string
  schedule_type: 'cron' | 'at' | 'every'
  schedule: string
  enabled: boolean
  instruction: string
  last_run?: number
  next_run?: number
  run_count: number
  last_result?: {
    success: boolean
    output: string
    error?: string
    duration_ms: number
  }
}

/**
 * 前端 CronHistoryItem DTO
 */
interface CronHistoryItemDTO {
  run_id: string
  success: boolean
  output: string
  error?: string
  duration_ms: number
  timestamp: number
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

const CRON_DIR = join(homedir(), '.claude', 'cron')
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
async function readJobs(): Promise<CronJobStore[]> {
  try {
    await ensureDir()
    const content = await fs.readFile(JOBS_FILE, 'utf-8')
    return JSON.parse(content) as CronJobStore[]
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
}

/**
 * 写入任务列表
 */
async function writeJobs(jobs: CronJobStore[]): Promise<void> {
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

/**
 * 将内部存储的 CronJobStore 转换为前端 DTO
 */
function toDTO(job: CronJobStore): CronJobDTO {
  return {
    id: job.id,
    name: job.name,
    schedule_type: job.schedule_type,
    schedule: job.schedule,
    enabled: job.enabled,
    instruction: job.instruction,
    last_run: job.lastRunAt,
    next_run: job.nextRunAt,
    run_count: job.run_count,
    last_result: job.last_result,
  }
}

// ─── 方法实现 ─────────────────────────────────────────────────────────────────

/**
 * getCronJobs → 获取所有 Cron 任务
 */
async function getCronJobs(): Promise<CronJobDTO[]> {
  const jobs = await readJobs()
  return jobs.map(toDTO)
}

/**
 * addCronJob → 添加新的 Cron 任务
 */
async function addCronJob(params: {
  name: string
  schedule: string
  schedule_type?: 'cron' | 'at' | 'every'
  instruction: string
  enabled?: boolean
}): Promise<{ job_id: string }> {
  if (!params.name || typeof params.name !== 'string') {
    throw new Error('参数 name 不能为空')
  }
  if (!params.schedule || typeof params.schedule !== 'string') {
    throw new Error('参数 schedule 不能为空')
  }
  if (!params.instruction || typeof params.instruction !== 'string') {
    throw new Error('参数 instruction 不能为空')
  }

  const jobs = await readJobs()
  const now = new Date().toISOString()

  const job: CronJobStore = {
    id: randomUUID(),
    name: params.name,
    schedule: params.schedule,
    schedule_type: params.schedule_type ?? 'cron',
    instruction: params.instruction,
    enabled: params.enabled !== undefined ? params.enabled : true,
    run_count: 0,
    createdAt: now,
    updatedAt: now,
  }

  jobs.push(job)
  await writeJobs(jobs)

  return { job_id: job.id }
}

/**
 * updateCronJob → 更新 Cron 任务
 */
async function updateCronJob(params: {
  id: string
  name?: string
  schedule?: string
  schedule_type?: 'cron' | 'at' | 'every'
  instruction?: string
  enabled?: boolean
}): Promise<void> {
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

  const updated: CronJobStore = {
    ...existing,
    name: params.name !== undefined ? params.name : existing.name,
    schedule: params.schedule !== undefined ? params.schedule : existing.schedule,
    schedule_type: params.schedule_type !== undefined ? params.schedule_type : existing.schedule_type,
    instruction: params.instruction !== undefined ? params.instruction : existing.instruction,
    enabled: params.enabled !== undefined ? params.enabled : existing.enabled,
    updatedAt: now,
  }

  jobs[idx] = updated
  await writeJobs(jobs)
}

/**
 * deleteCronJob → 删除 Cron 任务
 */
async function deleteCronJob(params: { id: string }): Promise<void> {
  if (!params.id) {
    throw new Error('参数 id 不能为空')
  }

  const jobs = await readJobs()
  const idx = jobs.findIndex(j => j.id === params.id)

  if (idx === -1) {
    throw new Error(`Cron 任务不存在: ${params.id}`)
  }

  jobs.splice(idx, 1)
  await writeJobs(jobs)
}

/**
 * runCronJob → 立即执行指定 Cron 任务（异步）
 */
async function runCronJob(
  params: { id: string },
  agentCore: AgentCoreLike,
): Promise<void> {
  if (!params.id) {
    throw new Error('参数 id 不能为空')
  }

  const jobs = await readJobs()
  const jobIdx = jobs.findIndex(j => j.id === params.id)

  if (jobIdx === -1) {
    throw new Error(`Cron 任务不存在: ${params.id}`)
  }

  const job = jobs[jobIdx]

  if (!job.enabled) {
    throw new Error(`Cron 任务已禁用: ${params.id}`)
  }

  const runId = randomUUID()
  const startTime = Date.now()

  // 更新任务的 lastRunAt
  jobs[jobIdx].lastRunAt = startTime
  jobs[jobIdx].updatedAt = new Date().toISOString()
  await writeJobs(jobs)

  // 异步执行（不阻塞 RPC 响应）
  executeJobAsync(runId, params.id, jobIdx, job.instruction, agentCore, startTime).catch(() => {
    // 错误已在 executeJobAsync 内部捕获并写入历史
  })
}

/**
 * 异步执行 Cron 任务的实际逻辑
 */
async function executeJobAsync(
  runId: string,
  jobId: string,
  jobIdx: number,
  instruction: string,
  agentCore: AgentCoreLike,
  startTime: number,
): Promise<void> {
  const outputChunks: string[] = []
  let success = true
  let errorMsg: string | undefined

  try {
    const generator = agentCore.execute(instruction)
    for await (const event of generator) {
      const e = event as { type?: string; content?: string; message?: string }
      if (e.type === 'text' && e.content) {
        outputChunks.push(e.content)
      } else if (e.type === 'error') {
        success = false
        errorMsg = e.message ?? '未知错误'
      }
    }
  } catch (err: unknown) {
    success = false
    errorMsg = err instanceof Error ? err.message : String(err)
  }

  const endTime = Date.now()
  const durationMs = endTime - startTime
  const output = outputChunks.join('')

  // 写入历史记录
  try {
    const history = await readHistory()
    const entry: CronHistoryEntry = {
      run_id: runId,
      job_id: jobId,
      success,
      output,
      error: errorMsg,
      duration_ms: durationMs,
      timestamp: startTime,
    }
    history.push(entry)
    // 保留最近 1000 条
    if (history.length > 1000) {
      history.splice(0, history.length - 1000)
    }
    await writeHistory(history)
  } catch {
    // 历史写入失败不影响任务执行结果
  }

  // 更新任务的 last_result 和 run_count
  try {
    const jobs = await readJobs()
    const idx = jobs.findIndex(j => j.id === jobId)
    if (idx !== -1) {
      jobs[idx].run_count = (jobs[idx].run_count ?? 0) + 1
      jobs[idx].last_result = { success, output, error: errorMsg, duration_ms: durationMs }
      jobs[idx].updatedAt = new Date().toISOString()
      await writeJobs(jobs)
    }
  } catch {
    // 任务状态更新失败不影响结果
  }
}

/**
 * getCronHistory → 获取执行历史
 */
async function getCronHistory(params: {
  id: string
}): Promise<CronHistoryItemDTO[]> {
  if (!params.id) {
    throw new Error('参数 id 不能为空')
  }

  let history = await readHistory()

  // 按 job_id 过滤
  history = history.filter(h => h.job_id === params.id)

  // 按时间降序排列（最新在前）
  history.sort((a, b) => b.timestamp - a.timestamp)

  return history.map(h => ({
    run_id: h.run_id,
    success: h.success,
    output: h.output,
    error: h.error,
    duration_ms: h.duration_ms,
    timestamp: h.timestamp,
  }))
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
    return addCronJob(params as {
      name: string
      schedule: string
      schedule_type?: 'cron' | 'at' | 'every'
      instruction: string
      enabled?: boolean
    })
  })

  server.registerMethod('updateCronJob', async (params: unknown) => {
    return updateCronJob(params as {
      id: string
      name?: string
      schedule?: string
      schedule_type?: 'cron' | 'at' | 'every'
      instruction?: string
      enabled?: boolean
    })
  })

  server.registerMethod('deleteCronJob', async (params: unknown) => {
    return deleteCronJob(params as { id: string })
  })

  server.registerMethod('runCronJob', async (params: unknown) => {
    return runCronJob(params as { id: string }, server.getAgentCore())
  })

  server.registerMethod('getCronHistory', async (params: unknown) => {
    return getCronHistory(params as { id: string })
  })
}
