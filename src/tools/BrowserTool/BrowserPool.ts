import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright'
import {
  BROWSER_LAUNCH_ARGS,
  BROWSER_PROFILE_CACHE_DIR,
  CHROME_USER_DATA_DIRS,
  CONTEXT_TTL_MS,
  DEFAULT_BROWSER_CHANNEL,
  MAX_CONTEXTS,
} from './constants.js'
import { applyStealthToContext, getStealthUserAgent } from './stealth.js'

interface SessionEntry {
  context: BrowserContext
  page: Page
  lastUsedAt: number
  /** persistent 模式下 context 由 pool 统一管理，关闭 session 时不关闭 context */
  ownedContext: boolean
}

// ============ 路径工具 ============

/** 展开 ~ 为实际 home 目录 */
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(2))
  }
  // Windows %LOCALAPPDATA% 展开
  if (p.startsWith('%LOCALAPPDATA%')) {
    const localAppData = process.env['LOCALAPPDATA'] ?? ''
    return p.replace('%LOCALAPPDATA%', localAppData)
  }
  return p
}

/** 获取当前平台对应的 Chrome 默认 user data 目录 */
function getDefaultChromeUserDataDir(): string | null {
  const platform = process.platform as keyof typeof CHROME_USER_DATA_DIRS
  const raw = CHROME_USER_DATA_DIRS[platform]
  if (!raw) return null
  return expandHome(raw)
}

/** 获取 BrowserTool 使用的 profile 目录（优先使用环境变量） */
function resolveBrowserProfileDir(): string {
  const envDir = process.env['BROWSER_USER_DATA_DIR']
  if (envDir) return expandHome(envDir)
  return expandHome(BROWSER_PROFILE_CACHE_DIR)
}

/**
 * 判断是否应启用 persistent context 模式。
 *
 * 启用条件：
 * - 显式设置了 BROWSER_USER_DATA_DIR，或
 * - BROWSER_PERSISTENT=true，或
 * - 默认策略：系统 Chrome 可用时自动使用 persistent（即未设置 BROWSER_PERSISTENT=false）
 *
 * 禁用条件：
 * - BROWSER_PERSISTENT=false（强制使用 headless 标准模式）
 */
function shouldUsePersistentContext(): boolean {
  const flag = process.env['BROWSER_PERSISTENT']
  if (flag === 'false' || flag === '0') return false
  if (flag === 'true' || flag === '1') return true
  // 有明确的 user data dir 指定 → 使用 persistent
  if (process.env['BROWSER_USER_DATA_DIR']) return true
  // 默认：开启 persistent（使用系统 Chrome + 独立 profile）
  return true
}

// ============ Launch 选项构建 ============

interface LaunchOptions {
  channel?: string
  executablePath?: string
  headless: boolean
  args: string[]
}

/**
 * 根据环境变量构建启动选项。
 *
 * 优先级：
 * 1. BROWSER_EXECUTABLE_PATH → executablePath
 * 2. BROWSER_CHANNEL → channel
 * 3. 默认 → channel: DEFAULT_BROWSER_CHANNEL ('chrome')，失败时由调用方 fallback
 */
function buildLaunchOptions(headless: boolean): LaunchOptions {
  const executablePath = process.env['BROWSER_EXECUTABLE_PATH']
  const channelEnv = process.env['BROWSER_CHANNEL']

  const base: LaunchOptions = {
    headless,
    args: [...BROWSER_LAUNCH_ARGS],
  }

  if (executablePath) {
    return { ...base, executablePath }
  }
  if (channelEnv) {
    return { ...base, channel: channelEnv }
  }
  // 默认使用系统 Chrome
  return { ...base, channel: DEFAULT_BROWSER_CHANNEL }
}

// ============ BrowserPool ============

class BrowserPool {
  /** 标准模式下的 Browser 单例 */
  private browser: Browser | null = null

  /**
   * Persistent 模式下的 BrowserContext 单例。
   * launchPersistentContext 直接返回 BrowserContext，不经过 Browser。
   */
  private persistentContext: BrowserContext | null = null

  private sessions: Map<string, SessionEntry> = new Map()

  // -------- 标准模式（headless，无登录态持久化） --------

  /**
   * 获取或创建标准模式 Browser 单例。
   * 优先使用系统 Chrome，失败时 fallback 到 Playwright Chromium。
   */
  private async getStandardBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser
    }

    const { chromium } = await import('playwright')
    const opts = buildLaunchOptions(true)

    try {
      this.browser = await chromium.launch(opts)
    } catch (err) {
      // 如果系统 Chrome 不可用（channel 模式），fallback 到 Playwright bundled Chromium
      if (opts.channel && !opts.executablePath) {
        console.warn(
          `[BrowserPool] 系统 Chrome (channel: ${opts.channel}) 启动失败，回退到 Playwright Chromium。错误: ${err}`,
        )
        this.browser = await chromium.launch({
          headless: true,
          args: [...BROWSER_LAUNCH_ARGS],
        })
      } else {
        throw err
      }
    }

    return this.browser
  }

  // -------- Persistent 模式（有界面，登录态持久化） --------

  /**
   * 确保 profile 目录存在。
   * 不自动从系统 Chrome 复制数据（因为 Chrome 运行时 profile 文件被锁定）。
   * 用户可手动将 Cookies 导出/导入，或在 BrowserTool 首次打开后手动登录。
   */
  private ensureProfileDir(profileDir: string): void {
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true })
    }
  }

  /**
   * 获取或创建 Persistent BrowserContext 单例。
   * 使用系统 Chrome + 独立 profile 目录，以 headed 模式运行，支持登录态持久化。
   *
   * 架构说明：
   * - launchPersistentContext 直接返回 BrowserContext，没有独立的 Browser 对象
   * - 整个 pool 共用一个 persistent context（单用户单会话场景）
   * - 多个 BrowserTool session 通过在同一 context 内开新 Page 来并发
   */
  private async getPersistentContext(): Promise<BrowserContext> {
    if (this.persistentContext) {
      return this.persistentContext
    }

    const { chromium } = await import('playwright')
    const profileDir = resolveBrowserProfileDir()
    this.ensureProfileDir(profileDir)

    const opts = buildLaunchOptions(false) // persistent 模式强制 headed

    try {
      this.persistentContext = await chromium.launchPersistentContext(profileDir, {
        ...opts,
        viewport: { width: 1920, height: 1080 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        userAgent: getStealthUserAgent(),
      })
    } catch (err) {
      // 系统 Chrome 不可用时，尝试用 Playwright bundled Chromium + persistent
      if (opts.channel && !opts.executablePath) {
        console.warn(
          `[BrowserPool] 系统 Chrome persistent context 启动失败，回退到 Playwright Chromium。错误: ${err}`,
        )
        this.persistentContext = await chromium.launchPersistentContext(profileDir, {
          headless: false,
          args: [...BROWSER_LAUNCH_ARGS],
          viewport: { width: 1920, height: 1080 },
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
          userAgent: getStealthUserAgent(),
        })
      } else {
        throw err
      }
    }

    // 注入反检测初始化脚本（在任何页面代码执行前运行）
    await applyStealthToContext(this.persistentContext)

    return this.persistentContext
  }

  // -------- 公共接口 --------

  /**
   * 获取指定 session 的 Page 实例。
   * - 同一 sessionId 始终返回同一个 Page
   * - 如果 Page 已关闭，自动创建新的
   * - 调用前自动执行驱逐检查
   *
   * 模式选择：
   * - persistent 模式（默认）：使用系统 Chrome + 独立 profile，headed，登录态持久化
   * - 标准模式（BROWSER_PERSISTENT=false）：headless，无登录态持久化
   */
  async getPage(sessionId: string): Promise<Page> {
    await this.evictStaleContexts()
    await this.evictLRU()

    const existing = this.sessions.get(sessionId)
    if (existing && !existing.page.isClosed()) {
      existing.lastUsedAt = Date.now()
      return existing.page
    }

    if (shouldUsePersistentContext()) {
      return this.getPageFromPersistentContext(sessionId)
    }
    return this.getPageFromStandardBrowser(sessionId)
  }

  /** 标准模式：创建新 context + page */
  private async getPageFromStandardBrowser(sessionId: string): Promise<Page> {
    const browser = await this.getStandardBrowser()
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: getStealthUserAgent(),
    })

    // 注入反检测初始化脚本（在任何页面代码执行前运行）
    await applyStealthToContext(context)

    const page = await context.newPage()
    page.setDefaultTimeout(30000)

    this.sessions.set(sessionId, {
      context,
      page,
      lastUsedAt: Date.now(),
      ownedContext: true,
    })
    return page
  }

  /** Persistent 模式：在共享 context 内创建新 page */
  private async getPageFromPersistentContext(sessionId: string): Promise<Page> {
    const context = await this.getPersistentContext()
    const page = await context.newPage()
    page.setDefaultTimeout(30000)

    this.sessions.set(sessionId, {
      context,
      page,
      lastUsedAt: Date.now(),
      ownedContext: false, // context 由 pool 统一管理，session 关闭时不关闭 context
    })
    return page
  }

  /**
   * 关闭指定 session 的 Page（以及独立 context，如果 ownedContext 为 true）
   */
  async closeSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (entry) {
      try {
        await entry.page.close()
        if (entry.ownedContext) {
          await entry.context.close()
        }
      } catch {
        // 忽略关闭错误
      }
      this.sessions.delete(sessionId)
    }
  }

  /**
   * 清理所有资源（进程退出时调用）
   */
  async cleanup(): Promise<void> {
    for (const [sessionId] of this.sessions) {
      await this.closeSession(sessionId)
    }

    // 关闭 persistent context
    if (this.persistentContext) {
      try {
        await this.persistentContext.close()
      } catch {
        // 忽略关闭错误
      }
      this.persistentContext = null
    }

    // 关闭标准 browser
    if (this.browser) {
      try {
        await this.browser.close()
      } catch {
        // 忽略关闭错误
      }
      this.browser = null
    }
  }

  /**
   * 驱逐超过 TTL 的 session
   */
  private async evictStaleContexts(): Promise<void> {
    const now = Date.now()
    const staleIds: string[] = []
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastUsedAt > CONTEXT_TTL_MS) {
        staleIds.push(id)
      }
    }
    for (const id of staleIds) {
      await this.closeSession(id)
    }
  }

  /**
   * LRU 驱逐：超过 MAX_CONTEXTS 时清理最久未使用的 session
   */
  private async evictLRU(): Promise<void> {
    const extra = this.sessions.size - MAX_CONTEXTS
    if (extra <= 0) return

    const sorted = [...this.sessions.entries()].sort(
      (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
    )
    const toEvict = sorted.slice(0, extra)
    for (const [id] of toEvict) {
      await this.closeSession(id)
    }
  }

  /**
   * 获取当前活跃的 session 数量
   */
  getActiveSessionCount(): number {
    return this.sessions.size
  }

  /**
   * 获取当前运行模式描述（用于日志/调试）
   */
  getMode(): string {
    if (shouldUsePersistentContext()) {
      const profileDir = resolveBrowserProfileDir()
      const channel = process.env['BROWSER_CHANNEL'] ?? DEFAULT_BROWSER_CHANNEL
      return `persistent (channel: ${channel}, profile: ${profileDir})`
    }
    const opts = buildLaunchOptions(true)
    return `standard headless (${opts.channel ? `channel: ${opts.channel}` : opts.executablePath ?? 'playwright chromium'})`
  }

  /**
   * 返回当前 profile 目录路径（persistent 模式下有效）
   */
  getProfileDir(): string | null {
    if (shouldUsePersistentContext()) {
      return resolveBrowserProfileDir()
    }
    return null
  }

  /**
   * 返回系统 Chrome 默认 user data 目录（供参考，不直接使用）
   */
  getDefaultChromeUserDataDir(): string | null {
    return getDefaultChromeUserDataDir()
  }
}

// 全局单例
export const browserPool = new BrowserPool()

/**
 * 清理浏览器池资源（供 sidecar entry 的 SIGTERM 处理调用）
 */
export async function cleanupBrowserPool(): Promise<void> {
  await browserPool.cleanup()
}
