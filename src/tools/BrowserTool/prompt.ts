export { TOOL_NAME_FOR_PROMPT as BROWSER_TOOL_NAME } from './constants.js'

export const DESCRIPTION = `
- Controls a real Chromium browser to interact with web pages and extract information
- Supports navigation, clicking, form filling, screenshots, text extraction, and JavaScript evaluation
- Maintains a browser context pool so multiple sessions can run concurrently
- Use this tool when you need to interact with dynamic web pages, fill forms, or capture screenshots

Supported actions and their required parameters:

  navigate      - Go to a URL
                  url: string (required)
                  wait_until?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'

  click         - Click an element on the page
                  selector: string (required, CSS selector or XPath)
                  button?: 'left' | 'right' | 'middle'

  fill          - Type text into an input field (clears existing value first)
                  selector: string (required)
                  value: string (required)

  screenshot    - Capture the current page as a PNG image
                  full_page?: boolean (default: false)
                  Returns screenshot_path: the local file path of the saved PNG

  extract       - Extract a summary of the current page content
                  Returns { title, url, text } — the page title, URL, and body text excerpt
                  (no selector or attribute parameters)

  evaluate      - Execute arbitrary JavaScript in the page context
                  script: string (required)
                  Returns the serialized return value of the script

  wait_for      - Wait for an element to appear
                  selector: string (required, CSS selector to wait for)
                  timeout?: number (milliseconds, default: 30000)

  upload_file   - Attach a local file to a file input element
                  selector: string (required, must match a file input)
                  file_path: string (required, absolute path on disk)

  get_text      - Get the visible text content of a specific element
                  selector: string (required)

  hover         - Move the mouse pointer over an element
                  selector: string (required)

  press_key     - Simulate a keyboard key press
                  key: string (required, e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown')

  select_option - Choose an option in a <select> element
                  selector: string (required)
                  value: string (required, the option value to select)

  check_checkbox - Set a checkbox or radio input to checked
                  selector: string (required)

  go_back       - Navigate to the previous page in browser history
                  (no additional parameters)

  refresh       - Reload the current page
                  (no additional parameters)

Usage notes:
  - Browser sessions are automatically managed per agent context — no context_id is needed
  - Browser contexts are automatically cleaned up after 30 minutes of inactivity
  - screenshot, extract, and get_text are read-only and do not modify the page
  - Use evaluate for complex interactions that other actions cannot handle
  - Selectors follow standard CSS selector syntax; XPath is also accepted with the "xpath=" prefix
  - This tool requires Playwright to be installed (npx playwright install chromium)
`
