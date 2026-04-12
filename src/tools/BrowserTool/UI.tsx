import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { Box, Text } from '../../ink.js'
import type { ToolProgressData } from '../../Tool.js'
import type { ProgressMessage } from '../../types/message.js'
import { truncate } from '../../utils/format.js'

interface Input {
  action: string
  url?: string
  selector?: string
  text?: string
  file_path?: string
  script?: string
  timeout?: number
  full_page?: boolean
}

interface Output {
  success: boolean
  content?: string
  screenshot_path?: string
  error?: string
}

export function renderToolUseMessage(
  input: Partial<Input>,
  { verbose }: { theme?: string; verbose: boolean },
): React.ReactNode {
  const { action, url, selector, text } = input
  if (!action) {
    return null
  }
  if (verbose) {
    const parts: string[] = [`action: "${action}"`]
    if (url) parts.push(`url: "${url}"`)
    if (selector) parts.push(`selector: "${selector}"`)
    if (text) parts.push(`text: "${text}"`)
    return parts.join(', ')
  }
  if (action === 'navigate' && url) {
    return `${action} ${url}`
  }
  if ((action === 'click' || action === 'hover' || action === 'get_text' || action === 'wait_for' || action === 'check_checkbox') && selector) {
    return `${action} ${selector}`
  }
  if (action === 'fill' && selector) {
    return text ? `${action} ${selector} "${text}"` : `${action} ${selector}`
  }
  if (action === 'select_option' && selector) {
    return text ? `${action} ${selector} "${text}"` : `${action} ${selector}`
  }
  return action
}

export function renderToolUseProgressMessage(): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Text dimColor>Running browser action…</Text>
    </MessageResponse>
  )
}

export function renderToolResultMessage(
  output: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const { success, content, screenshot_path, error } = output
  if (!success) {
    return (
      <MessageResponse height={1}>
        <Text>
          <Text color="error">Failed</Text>
          {error ? `: ${error}` : ''}
        </Text>
      </MessageResponse>
    )
  }
  if (verbose) {
    return (
      <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text color="success">Success</Text>
        </MessageResponse>
        {screenshot_path && (
          <Box flexDirection="column">
            <Text dimColor>Screenshot: {screenshot_path}</Text>
          </Box>
        )}
        {content && (
          <Box flexDirection="column">
            <Text>{content}</Text>
          </Box>
        )}
      </Box>
    )
  }
  return (
    <MessageResponse height={1}>
      <Text>
        <Text color="success">Success</Text>
        {screenshot_path ? ` (screenshot: ${screenshot_path})` : ''}
      </Text>
    </MessageResponse>
  )
}

export function getToolUseSummary(
  input: Partial<Input> | undefined,
): string | null {
  if (!input?.action) {
    return null
  }
  const { action, url, selector, full_page } = input
  if (action === 'navigate' && url) {
    return truncate(`${action} ${url}`, TOOL_SUMMARY_MAX_LENGTH)
  }
  if (action === 'screenshot') {
    return full_page ? 'screenshot (full page)' : 'screenshot'
  }
  if (selector) {
    return truncate(`${action} ${selector}`, TOOL_SUMMARY_MAX_LENGTH)
  }
  return action
}
