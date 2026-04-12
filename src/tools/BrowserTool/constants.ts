/** 工具名称 */
export const TOOL_NAME_FOR_PROMPT = 'BrowserTool'

/** Session 最大空闲 TTL（30 分钟） */
export const CONTEXT_TTL_MS = 30 * 60 * 1000

/** 允许同时存活的最大 Context 数量 */
export const MAX_CONTEXTS = 5

/** Chromium 启动参数（提升容器环境兼容性 + 反自动化检测） */
export const BROWSER_LAUNCH_ARGS: string[] = [
  // ---- 容器环境兼容性 ----
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-translate',
  '--hide-scrollbars',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-first-run',
  '--safebrowsing-disable-auto-update',
  // ---- 反自动化检测 ----
  // 关键：移除 navigator.webdriver / AutomationControlled 标识
  '--disable-blink-features=AutomationControlled',
  // 移除 "Chrome is being controlled by automated software" 信息栏
  '--disable-infobars',
  // 模拟真实用户的窗口尺寸（避免 screen.width/height 异常）
  '--window-size=1920,1080',
  // 启用媒体流假 UI（避免 headless 下媒体相关特征泄露）
  '--use-fake-ui-for-media-stream',
]

// ============ 浏览器选择与登录态复用配置 ============

/**
 * 默认使用系统 Chrome channel。
 * 使用 channel: 'chrome' 时，Playwright 直接调用系统已安装的 Google Chrome，
 * 无需执行 playwright install chromium。
 */
export const DEFAULT_BROWSER_CHANNEL = 'chrome'

/**
 * 各平台 Chrome 默认 user data 目录路径。
 * 注意：Playwright 官方明确说明不支持直接使用 Chrome 的默认 Default profile，
 * 因为 Chrome 会对该 profile 加锁，且 Chrome 策略变更后自动化该 profile 不被支持。
 * 这里仅作为参考路径，实际使用时应复制 cookies 到独立 profile。
 */
export const CHROME_USER_DATA_DIRS: Record<string, string> = {
  darwin: '~/Library/Application Support/Google/Chrome',
  win32: '%LOCALAPPDATA%\\Google\\Chrome\\User Data',
  linux: '~/.config/google-chrome',
}

/**
 * BrowserTool 独立 profile 目录（避免与正在运行的 Chrome 产生锁冲突）。
 * 使用 launchPersistentContext 时，Playwright 将在此目录维护独立的 session 数据，
 * 包括 Cookies、localStorage 等，实现跨 BrowserTool 调用的登录态持久化。
 */
export const BROWSER_PROFILE_CACHE_DIR = '~/.claude/browser-profile'
