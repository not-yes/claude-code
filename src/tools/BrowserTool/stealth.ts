/**
 * stealth.ts — 反检测措施
 *
 * 隐藏 Playwright 自动化特征，避免被网站检测和阻拦。
 * 涵盖以下检测点：
 * - navigator.webdriver 属性
 * - window.chrome.runtime 缺失
 * - permissions API 异常
 * - navigator.plugins 为空（headless 特征）
 * - navigator.languages 异常
 * - User-Agent 中的 HeadlessChrome 标识
 */

import type { BrowserContext } from 'playwright'

// ============ 反检测 Chrome 启动参数 ============

/**
 * 反检测相关的 Chrome 启动参数。
 * 与 BROWSER_LAUNCH_ARGS 合并使用（见 constants.ts）。
 */
export const STEALTH_ARGS: string[] = [
  // 关键：移除 "AutomationControlled" 自动化控制标识（navigator.webdriver 等）
  '--disable-blink-features=AutomationControlled',
  // 移除 "Chrome is being controlled by automated software" 信息栏
  '--disable-infobars',
  // 减少隔离特征（某些检测会探测 site-per-process 行为）
  '--disable-features=IsolateOrigins,site-per-process',
  // 禁用自动化扩展（会暴露 --enable-automation flag）
  '--disable-extensions-except=',
  // 启用媒体编解码器（headless 下默认禁用，会被检测到缺失）
  '--use-fake-ui-for-media-stream',
  // 模拟真实用户的窗口尺寸（避免 screen.width/height 异常）
  '--window-size=1920,1080',
]

// ============ 真实 Chrome User-Agent ============

/**
 * 返回一个真实的 Chrome User-Agent（不含 HeadlessChrome 标识）。
 * 版本号与常见的系统 Chrome 对齐。
 */
export function getStealthUserAgent(): string {
  const platform = process.platform
  if (platform === 'darwin') {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  }
  if (platform === 'win32') {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  }
  // Linux
  return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
}

// ============ Context 反检测脚本注入 ============

/**
 * 向 BrowserContext 注入反检测初始化脚本。
 *
 * 使用 addInitScript 保证脚本在每个页面（包括 iframe）的任何页面代码执行前运行，
 * 因此网站的检测代码无法在我们修改属性之前抢先读取。
 */
export async function applyStealthToContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // ---- 1. 覆盖 navigator.webdriver（最关键的检测点） ----
    // 自动化浏览器下此属性为 true，正常浏览器为 undefined
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    })

    // ---- 2. 模拟 window.chrome.runtime（非 headless 的 Chrome 应有此对象） ----
    const win = window as unknown as Window & { chrome?: Record<string, unknown> }
    if (!win.chrome) {
      win.chrome = {}
    }
    const chrome = win.chrome
    if (!chrome['runtime']) {
      chrome['runtime'] = {
        // 模拟最常被检测的属性
        connect: () => {},
        sendMessage: () => {},
        id: undefined,
        onMessage: { addListener: () => {}, removeListener: () => {} },
        onConnect: { addListener: () => {}, removeListener: () => {} },
      }
    }

    // ---- 3. 修复 permissions.query（headless 下返回异常结果） ----
    // 正常浏览器对 notifications 权限的查询应返回当前通知权限状态
    const originalPermissionsQuery = window.navigator.permissions.query.bind(
      window.navigator.permissions,
    )
    window.navigator.permissions.query = (parameters: PermissionDescriptor) => {
      if (parameters.name === 'notifications') {
        return Promise.resolve({
          state: Notification.permission,
          name: 'notifications',
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => true,
        } as PermissionStatus)
      }
      return originalPermissionsQuery(parameters)
    }

    // ---- 4. 修复 navigator.plugins（headless 下为空，会被检测到） ----
    // 真实 Chrome 含有 PDF Viewer 等内置插件
    const fakePlugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: '' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      {
        name: 'Native Client',
        filename: 'internal-nacl-plugin',
        description: 'Native Client',
      },
    ]
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = Object.assign([], fakePlugins) as unknown as PluginArray
        ;(arr as unknown as { refresh: () => void }).refresh = () => {}
        return arr
      },
      configurable: true,
    })

    // ---- 5. 修复 navigator.languages（headless 下可能为空或异常） ----
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en-US', 'en'],
      configurable: true,
    })

    // ---- 6. 修复 navigator.platform（headless 有时返回空字符串） ----
    // 使用 as unknown as string 绕过 TS 的字面量枚举检查（运行时实际值可能为空）
    const currentPlatform = navigator.platform as unknown as string
    if (!currentPlatform || currentPlatform === '') {
      Object.defineProperty(navigator, 'platform', {
        get: () => 'MacIntel',
        configurable: true,
      })
    }

    // ---- 7. 覆盖 toString 防止函数原生性检测 ----
    // 某些检测脚本会检查 navigator.webdriver.toString() 等来判断是否被覆盖
    // 通过让覆盖的函数看起来像原生函数来规避
    const nativeToString = Function.prototype.toString
    Function.prototype.toString = function (this: Function) {
      if (this === window.navigator.permissions.query) {
        return 'function query() { [native code] }'
      }
      return nativeToString.call(this)
    }
  })
}
