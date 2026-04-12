/**
 * sidecar/cronScheduler.ts
 *
 * Sidecar 专用 Cron 调度器。
 *
 * 相比 CLI 版本（utils/cronScheduler.ts），这是一个极简实现：
 * - 无多会话锁（Sidecar 是单进程）
 * - 无 jitter（桌面应用不需要负载均衡）
 * - 无 chokidar（通过 refreshSchedule() 主动触发）
 * - 30 秒检查间隔（桌面场景足够）
 */

import { parseCronExpression, computeNextCronRun } from '../utils/cron.js'
import type { CronJobStore } from './handlers/cronHandler.js'

// ─── 外部依赖接口 ─────────────────────────────────────────────────────────────

/**
 * 调度器所需的外部依赖，通过构造函数注入，方便测试与解耦。
 */
export interface CronSchedulerDeps {
  /** 读取所有 Cron 任务列表 */
  readJobs: () => Promise<CronJobStore[]>
  /** 写入更新后的任务列表 */
  writeJobs: (jobs: CronJobStore[]) => Promise<void>
  /** 执行指定任务的实际逻辑 */
  executeJob: (jobId: string, jobName: string, instruction: string) => Promise<void>
  /** 向前端发送 JSON-RPC 通知 */
  sendNotification: (method: string, params: unknown) => Promise<void>
  /** 日志输出 */
  log: (level: 'INFO' | 'WARN' | 'ERROR', ...args: unknown[]) => void
}

// ─── SidecarCronScheduler ─────────────────────────────────────────────────────

/**
 * Sidecar 模式下的极简 Cron 调度器。
 *
 * 每 30 秒检查一次所有已启用的 cron 类型任务，
 * 若当前时间 >= 计算出的下次触发时间则执行该任务。
 */
export class SidecarCronScheduler {
  /** setInterval 返回的定时器句柄 */
  private timer: ReturnType<typeof setInterval> | null = null

  /** 缓存每个任务的下次触发时间（jobId → epoch ms），避免每次重新解析 cron 表达式 */
  private nextFireAt = new Map<string, number>()

  /** 防重入标志：check() 执行期间不允许再次进入 */
  private checking = false

  constructor(private deps: CronSchedulerDeps) {}

  /**
   * 启动调度器：
   * 1. 创建 30 秒周期性定时器
   * 2. 调用 unref() 避免阻塞进程退出（Node/Bun 均支持）
   * 3. 立即触发一次检查，确保启动后尽快执行到期任务
   */
  start(): void {
    this.deps.log('INFO', 'Cron 调度器启动')
    this.timer = setInterval(() => { void this.check() }, 30_000)
    this.timer.unref?.()
    // 启动后立即检查一次
    void this.check()
  }

  /**
   * 停止调度器：
   * 清除定时器并重置缓存状态。
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.nextFireAt.clear()
    this.deps.log('INFO', 'Cron 调度器已停止')
  }

  /**
   * 主动刷新调度计划：
   * 清空下次触发时间缓存，并立即执行一次检查。
   * 通常在任务被新增、修改或删除后由外部调用。
   */
  refreshSchedule(): void {
    this.nextFireAt.clear()
    void this.check()
  }

  /**
   * 核心检查逻辑：遍历所有已启用的 cron 任务，触发到期的任务。
   *
   * 使用 `this.checking` 标志防止并发重入（例如 check() 执行时间超过 30s 的极端情况）。
   */
  private async check(): Promise<void> {
    // 防重入：上次检查尚未完成时直接跳过
    if (this.checking) return
    this.checking = true

    try {
      const jobs = await this.deps.readJobs()
      const now = Date.now()

      // 收集当前仍存在的 jobId 集合，用于清理过期缓存
      const existingIds = new Set<string>()

      for (const job of jobs) {
        // 跳过已禁用的任务
        if (!job.enabled) continue

        // 目前只处理 cron 类型；at/every 类型留待后续迭代支持
        if (job.schedule_type !== 'cron') continue

        existingIds.add(job.id)

        // 若缓存中没有该任务的下次触发时间，则计算并缓存
        if (!this.nextFireAt.has(job.id)) {
          const fields = parseCronExpression(job.schedule)
          if (!fields) {
            this.deps.log('WARN', `[CronScheduler] 无效的 cron 表达式，跳过任务: ${job.id} schedule="${job.schedule}"`)
            continue
          }

          // 以上次运行时间为基准；若从未运行过，则以当前时间为基准
          const anchor = job.lastRunAt ? new Date(job.lastRunAt) : new Date()
          const nextRun = computeNextCronRun(fields, anchor)
          if (!nextRun) {
            this.deps.log('WARN', `[CronScheduler] 无法计算下次运行时间，跳过任务: ${job.id}`)
            continue
          }

          this.nextFireAt.set(job.id, nextRun.getTime())
        }

        const nextFire = this.nextFireAt.get(job.id)!

        // 当前时间已超过或等于下次触发时间，执行任务
        if (now >= nextFire) {
          this.deps.log('INFO', `[CronScheduler] 触发任务: ${job.id} name="${job.name}"`)

          // 执行任务：出错只记录日志，不抛出，确保不影响其他任务的检查
          try {
            await this.deps.executeJob(job.id, job.name, job.instruction)
          } catch (err: unknown) {
            this.deps.log('ERROR', `[CronScheduler] 任务执行失败: ${job.id}`, err)
          }

          // 更新 run_count 和 lastRunAt
          const nowTs = Date.now()
          job.run_count = (job.run_count ?? 0) + 1
          job.lastRunAt = nowTs

          // 计算新的 nextRunAt
          const fields = parseCronExpression(job.schedule)
          if (fields) {
            const nextRun = computeNextCronRun(fields, new Date(nowTs))
            if (nextRun) {
              job.nextRunAt = nextRun.getTime()
              this.nextFireAt.set(job.id, nextRun.getTime())
            } else {
              // 计算失败则从缓存中移除，下次检查时重新计算
              this.nextFireAt.delete(job.id)
            }
          } else {
            this.nextFireAt.delete(job.id)
          }

          // 写回更新后的任务列表（只更新本次触发的任务字段）
          try {
            const latestJobs = await this.deps.readJobs()
            const idx = latestJobs.findIndex(j => j.id === job.id)
            if (idx !== -1) {
              latestJobs[idx].run_count = job.run_count
              latestJobs[idx].lastRunAt = job.lastRunAt
              if (job.nextRunAt !== undefined) {
                latestJobs[idx].nextRunAt = job.nextRunAt
              }
              await this.deps.writeJobs(latestJobs)
            }
          } catch (err: unknown) {
            this.deps.log('ERROR', `[CronScheduler] 写回任务状态失败: ${job.id}`, err)
          }

          // 通知前端任务已触发
          try {
            await this.deps.sendNotification('$/cron', {
              job_id: job.id,
              job_name: job.name,
              status: 'triggered',
              trigger: 'scheduler',
            })
          } catch (err: unknown) {
            this.deps.log('WARN', `[CronScheduler] 发送通知失败: ${job.id}`, err)
          }
        }
      }

      // 清理 nextFireAt 中已不存在（或被禁用）的任务条目
      for (const cachedId of this.nextFireAt.keys()) {
        if (!existingIds.has(cachedId)) {
          this.nextFireAt.delete(cachedId)
        }
      }
    } catch (err: unknown) {
      this.deps.log('ERROR', '[CronScheduler] check() 出现未预期错误', err)
    } finally {
      this.checking = false
    }
  }
}
