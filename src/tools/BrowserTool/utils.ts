import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 生成跨平台的截图文件路径
 */
export function getScreenshotPath(): string {
  return join(tmpdir(), `browser-screenshot-${Date.now()}.png`)
}

/**
 * 统一格式化错误消息
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

/**
 * 延迟工具函数
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
