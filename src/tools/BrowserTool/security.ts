import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface DomainCheckResult {
  allowed: boolean
  reason?: string
}

export interface EvaluateCheckResult {
  allowed: boolean
  reason?: string
  warnings: string[]
}

// ─────────────────────────────────────────────
// Config file schema
// ─────────────────────────────────────────────

interface BrowserToolConfig {
  allowedDomains?: string[]
}

// ─────────────────────────────────────────────
// getAllowedDomains — three-tier priority
// ─────────────────────────────────────────────

/**
 * 从三级优先级读取允许的域名列表：
 * 1. 环境变量 BROWSER_ALLOWED_DOMAINS（逗号分隔）
 * 2. 配置文件 ~/.claude/browser-tool.json 中的 allowedDomains 数组
 * 3. 空数组（不限制，全部允许）
 */
function getAllowedDomains(): string[] {
  // Priority 1: environment variable
  const envValue = process.env['BROWSER_ALLOWED_DOMAINS']
  if (envValue && envValue.trim().length > 0) {
    return envValue
      .split(',')
      .map((d) => d.trim())
      .filter((d) => d.length > 0)
  }

  // Priority 2: config file ~/.claude/browser-tool.json
  const configPath = join(homedir(), '.claude', 'browser-tool.json')
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8')
      const config: BrowserToolConfig = JSON.parse(raw) as BrowserToolConfig
      if (Array.isArray(config.allowedDomains)) {
        return config.allowedDomains
          .filter((d): d is string => typeof d === 'string')
          .map((d) => d.trim())
          .filter((d) => d.length > 0)
      }
    } catch {
      // File unreadable or JSON invalid — fall through to default
    }
  }

  // Priority 3: empty list (no restriction)
  return []
}

// Cache at module load time (sidecar is a long-lived process; avoids repeated I/O)
const ALLOWED_DOMAINS: string[] = getAllowedDomains()

// ─────────────────────────────────────────────
// Wildcard matching helper
// ─────────────────────────────────────────────

/**
 * 将域名模式转换为正则表达式
 * - `*.example.com` 匹配任意子域（不含空子域）
 * - `example.com` 仅精确匹配
 */
function patternToRegex(pattern: string): RegExp {
  // Escape all regex meta-characters except '*'
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  // Replace wildcard '*' — must match at least one character that is not '.'
  //   so *.example.com does NOT match example.com itself
  const regexStr = '^' + escaped.replace(/\*/g, '[^.]+') + '$'
  return new RegExp(regexStr, 'i')
}

function matchesDomainPattern(hostname: string, pattern: string): boolean {
  try {
    return patternToRegex(pattern).test(hostname)
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────
// checkDomainAllowed
// ─────────────────────────────────────────────

/**
 * 检查 URL 的域名是否在白名单中
 * - 支持通配符匹配，如 *.chinatax.gov.cn
 * - 白名单为空时，所有域名都允许
 */
export function checkDomainAllowed(url: string): DomainCheckResult {
  // Empty whitelist → allow all
  if (ALLOWED_DOMAINS.length === 0) {
    return { allowed: true }
  }

  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return {
      allowed: false,
      reason: `Invalid URL: "${url}"`,
    }
  }

  for (const pattern of ALLOWED_DOMAINS) {
    if (matchesDomainPattern(hostname, pattern)) {
      return { allowed: true }
    }
  }

  return {
    allowed: false,
    reason: `Domain "${hostname}" is not in the allowed domains list. ` +
      `Configure allowed domains via BROWSER_ALLOWED_DOMAINS environment variable ` +
      `or ~/.claude/browser-tool.json.`,
  }
}

// ─────────────────────────────────────────────
// checkEvaluateSecurity
// ─────────────────────────────────────────────

const DANGEROUS_APIS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bfetch\s*\(/, label: 'fetch()' },
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest' },
  { pattern: /\bWebSocket\s*\(/, label: 'WebSocket()' },
  { pattern: /\beval\s*\(/, label: 'eval()' },
  { pattern: /\bnew\s+Function\s*\(/, label: 'new Function()' },
]

const SENSITIVE_DATA_APIS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bdocument\.cookie\b/, label: 'document.cookie' },
  { pattern: /\blocalStorage\b/, label: 'localStorage' },
  { pattern: /\bsessionStorage\b/, label: 'sessionStorage' },
]

const SCRIPT_LENGTH_WARNING_THRESHOLD = 5000

/**
 * 检查要执行的 JavaScript 脚本的安全性
 * - 检查脚本长度（超过 5000 字符警告）
 * - 检查危险 API 使用（fetch、XMLHttpRequest、WebSocket、eval、Function）
 * - 检查敏感数据访问（document.cookie、localStorage、sessionStorage）
 * - 返回 allowed=true 但附带 warnings（由 checkPermissions 决定是否阻止）
 */
export function checkEvaluateSecurity(script: string): EvaluateCheckResult {
  const warnings: string[] = []

  // Length check
  if (script.length > SCRIPT_LENGTH_WARNING_THRESHOLD) {
    warnings.push(
      `Script is ${script.length} characters long (threshold: ${SCRIPT_LENGTH_WARNING_THRESHOLD}). ` +
        `Long scripts increase the risk of unintended behavior.`,
    )
  }

  // Dangerous API checks
  for (const { pattern, label } of DANGEROUS_APIS) {
    if (pattern.test(script)) {
      warnings.push(`Script uses dangerous API: ${label}`)
    }
  }

  // Sensitive data access checks
  for (const { pattern, label } of SENSITIVE_DATA_APIS) {
    if (pattern.test(script)) {
      warnings.push(`Script accesses sensitive data: ${label}`)
    }
  }

  return {
    allowed: true,
    warnings,
  }
}
