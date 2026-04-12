import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { browserPool } from './BrowserPool.js'
import { TOOL_NAME_FOR_PROMPT } from './constants.js'
import { DESCRIPTION, BROWSER_TOOL_NAME } from './prompt.js'
import { checkDomainAllowed, checkEvaluateSecurity } from './security.js'
import { formatError, getScreenshotPath } from './utils.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

export const BROWSER_ACTIONS = [
  'navigate',
  'click',
  'fill',
  'screenshot',
  'extract',
  'evaluate',
  'wait_for',
  'upload_file',
  'get_text',
  'hover',
  'press_key',
  'select_option',
  'check_checkbox',
  'go_back',
  'refresh',
] as const

export type BrowserAction = (typeof BROWSER_ACTIONS)[number]

/** Actions that do not mutate page state */
const READ_ONLY_ACTIONS: ReadonlySet<BrowserAction> = new Set([
  'screenshot',
  'extract',
  'get_text',
])

const DEFAULT_TIMEOUT_MS = 30_000

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z.enum(BROWSER_ACTIONS).describe('Browser action to perform'),
    url: z
      .string()
      .url()
      .optional()
      .describe('URL to navigate to (required for navigate action)'),
    selector: z
      .string()
      .optional()
      .describe('CSS selector for element targeting'),
    text: z
      .string()
      .optional()
      .describe('Text to input (for fill, press_key, select_option)'),
    file_path: z
      .string()
      .optional()
      .describe('Absolute file path to upload'),
    script: z
      .string()
      .optional()
      .describe('JavaScript code to evaluate (must be a function string)'),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Timeout in milliseconds (default: 30000)'),
    full_page: z
      .boolean()
      .optional()
      .describe('Capture full page screenshot (default: false)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean().describe('Whether the action succeeded'),
    content: z.string().optional().describe('Text content or result data'),
    screenshot_path: z
      .string()
      .optional()
      .describe('Path to saved screenshot file'),
    error: z.string().optional().describe('Error message if action failed'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// ─────────────────────────────────────────────
// Tool
// ─────────────────────────────────────────────

export const BrowserTool = buildTool({
  name: BROWSER_TOOL_NAME,
  searchHint: 'control browser, navigate pages, click elements, fill forms, take screenshots',
  maxResultSizeChars: 50_000,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  async description(input) {
    const { action, url, selector } = input as {
      action?: string
      url?: string
      selector?: string
    }
    switch (action) {
      case 'navigate':
        return url
          ? `Navigate to ${url}`
          : 'Navigate to a URL'
      case 'click':
        return selector ? `Click element: ${selector}` : 'Click an element'
      case 'fill':
        return selector ? `Fill input: ${selector}` : 'Fill an input field'
      case 'screenshot':
        return 'Take a screenshot of the current page'
      case 'extract':
        return selector
          ? `Extract content from: ${selector}`
          : 'Extract page content'
      case 'evaluate':
        return 'Evaluate JavaScript in the page'
      case 'wait_for':
        return selector
          ? `Wait for element: ${selector}`
          : 'Wait for an element'
      case 'upload_file':
        return selector ? `Upload file to: ${selector}` : 'Upload a file'
      case 'get_text':
        return selector
          ? `Get text from: ${selector}`
          : 'Get text from the page'
      case 'hover':
        return selector ? `Hover over: ${selector}` : 'Hover over an element'
      case 'press_key':
        return 'Press a keyboard key'
      case 'select_option':
        return selector
          ? `Select option in: ${selector}`
          : 'Select a dropdown option'
      case 'check_checkbox':
        return selector
          ? `Check checkbox: ${selector}`
          : 'Check a checkbox'
      case 'go_back':
        return 'Navigate back in browser history'
      case 'refresh':
        return 'Reload the current page'
      default:
        return 'Perform a browser action'
    }
  },

  userFacingName() {
    return TOOL_NAME_FOR_PROMPT
  },

  getToolUseSummary,

  getActivityDescription(input) {
    const { action, url, selector } = (input ?? {}) as {
      action?: string
      url?: string
      selector?: string
    }
    switch (action) {
      case 'navigate':
        return url ? `Navigating to ${url}` : 'Navigating...'
      case 'click':
        return selector ? `Clicking ${selector}` : 'Clicking...'
      case 'fill':
        return selector ? `Filling ${selector}` : 'Filling form...'
      case 'screenshot':
        return 'Taking screenshot...'
      case 'extract':
        return 'Extracting page content...'
      case 'evaluate':
        return 'Evaluating script...'
      case 'wait_for':
        return selector ? `Waiting for ${selector}` : 'Waiting...'
      case 'upload_file':
        return 'Uploading file...'
      case 'get_text':
        return 'Getting text content...'
      case 'hover':
        return selector ? `Hovering over ${selector}` : 'Hovering...'
      case 'press_key':
        return 'Pressing key...'
      case 'select_option':
        return 'Selecting option...'
      case 'check_checkbox':
        return 'Checking checkbox...'
      case 'go_back':
        return 'Navigating back...'
      case 'refresh':
        return 'Refreshing page...'
      default:
        return 'Running browser action...'
    }
  },

  isConcurrencySafe() {
    return false
  },

  isReadOnly(input) {
    return (READ_ONLY_ACTIONS as Set<string>).has(input.action)
  },

  toAutoClassifierInput(input) {
    const { action, url, selector } = input
    const parts: string[] = [action]
    if (url) parts.push(url)
    if (selector) parts.push(selector)
    return parts.join(' ')
  },

  async validateInput(input) {
    const { action, url, selector, text, file_path, script } = input
    switch (action) {
      case 'navigate':
        if (!url) return { result: false as const, message: 'navigate action requires "url" parameter', errorCode: 1 }
        break
      case 'click':
      case 'hover':
      case 'check_checkbox':
      case 'wait_for':
      case 'get_text':
        if (!selector) return { result: false as const, message: `${action} action requires "selector" parameter`, errorCode: 1 }
        break
      case 'fill':
        if (!selector || !text) return { result: false as const, message: 'fill action requires "selector" and "text" parameters', errorCode: 1 }
        break
      case 'upload_file':
        if (!selector || !file_path) return { result: false as const, message: 'upload_file action requires "selector" and "file_path" parameters', errorCode: 1 }
        break
      case 'evaluate':
        if (!script) return { result: false as const, message: 'evaluate action requires "script" parameter', errorCode: 1 }
        break
      case 'press_key':
        if (!text) return { result: false as const, message: 'press_key action requires "text" parameter', errorCode: 1 }
        break
      case 'select_option':
        if (!selector || !text) return { result: false as const, message: 'select_option action requires "selector" and "text" parameters', errorCode: 1 }
        break
    }
    return { result: true as const }
  },

  async checkPermissions(input, _context): Promise<PermissionDecision> {
    const { action, url, script } = input

    if (action === 'navigate' && url) {
      const domainCheck = checkDomainAllowed(url)
      if (!domainCheck.allowed) {
        return {
          behavior: 'deny',
          message: domainCheck.reason ?? `Access to ${url} is not allowed.`,
          decisionReason: {
            type: 'other',
            reason: domainCheck.reason ?? 'Domain not in allowed list',
          },
        }
      }
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'other', reason: 'Domain allowed' },
      }
    }

    if (action === 'evaluate' && script) {
      const secCheck = checkEvaluateSecurity(script)
      if (secCheck.warnings.length > 0) {
        return {
          behavior: 'ask',
          message: `The script has security warnings:\n${secCheck.warnings.map(w => `  • ${w}`).join('\n')}`,
          decisionReason: {
            type: 'safetyCheck',
            reason: secCheck.warnings.join('; '),
            classifierApprovable: true,
          },
        }
      }
    }

    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'other', reason: 'Action allowed' },
    }
  },

  async prompt(_options) {
    return DESCRIPTION
  },

  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,

  async call(input, context) {
    const { action, url, selector, text, file_path, script, timeout, full_page } = input
    const sessionId: string = context.agentId ?? 'default'

    let result: Output

    try {
      const page = await browserPool.getPage(sessionId)

      if (timeout) {
        page.setDefaultTimeout(timeout)
      }

      switch (action) {
        case 'navigate': {
          await page.goto(url!, { waitUntil: 'networkidle' })
          result = {
            success: true,
            content: `Navigated to: ${await page.title()}`,
          }
          break
        }

        case 'click': {
          await page.click(selector!)
          await page.waitForLoadState('networkidle').catch(() => {})
          result = { success: true, content: `Clicked: ${selector}` }
          break
        }

        case 'fill': {
          await page.fill(selector!, text!)
          result = { success: true, content: `Filled ${selector} with text` }
          break
        }

        case 'screenshot': {
          const screenshotPath = getScreenshotPath()
          await page.screenshot({
            path: screenshotPath,
            fullPage: full_page ?? false,
          })
          result = { success: true, screenshot_path: screenshotPath }
          break
        }

        case 'extract': {
          const title = await page.title()
          const bodyText = await page.textContent('body')
          result = {
            success: true,
            content: JSON.stringify({
              title,
              url: page.url(),
              text: bodyText?.substring(0, 10000),
            }),
          }
          break
        }

        case 'evaluate': {
          const evalResult = await page.evaluate(script!)
          result = { success: true, content: JSON.stringify(evalResult) }
          break
        }

        case 'wait_for': {
          await page.waitForSelector(selector!, {
            timeout: timeout ?? DEFAULT_TIMEOUT_MS,
          })
          result = { success: true, content: `Element found: ${selector}` }
          break
        }

        case 'upload_file': {
          await page.setInputFiles(selector!, file_path!)
          result = { success: true, content: `File uploaded: ${file_path}` }
          break
        }

        case 'get_text': {
          const textContent = await page.textContent(selector!)
          result = { success: true, content: textContent ?? '' }
          break
        }

        case 'hover': {
          await page.hover(selector!)
          result = { success: true, content: `Hovered: ${selector}` }
          break
        }

        case 'press_key': {
          await page.keyboard.press(text!)
          result = { success: true, content: `Pressed key: ${text}` }
          break
        }

        case 'select_option': {
          await page.selectOption(selector!, { label: text! })
          result = { success: true, content: `Selected: ${text}` }
          break
        }

        case 'check_checkbox': {
          await page.check(selector!)
          result = { success: true, content: `Checked: ${selector}` }
          break
        }

        case 'go_back': {
          await page.goBack()
          result = { success: true, content: 'Navigated back' }
          break
        }

        case 'refresh': {
          await page.reload()
          result = { success: true, content: 'Page refreshed' }
          break
        }

        default: {
          const _exhaustive: never = action
          result = {
            success: false,
            error: `Unknown action: ${String(_exhaustive)}`,
          }
        }
      }
    } catch (error) {
      return {
        data: { success: false, error: formatError(error) },
      }
    }

    return { data: result }
  },

  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const text = content.error
      ? `Error: ${content.error}`
      : content.screenshot_path
        ? `Screenshot saved to: ${content.screenshot_path}`
        : (content.content ?? 'Success')

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: text,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
