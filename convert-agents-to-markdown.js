#!/usr/bin/env node

/**
 * 将 JSON 格式的 agents 转换为 Markdown 格式
 * 用法: node convert-agents-to-markdown.js
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const AGENTS_DIR = join(homedir(), '.claude', 'agents')

/**
 * 将 JSON agent 转换为 Markdown 格式
 */
function convertToJson(agent) {
  const frontmatter = [
    '---',
    `name: ${agent.name}`,
    `description: ${agent.description || ''}`,
  ]

  // model
  if (agent.model) {
    frontmatter.push(`model: ${agent.model}`)
  }

  // max_iterations
  if (agent.max_iterations) {
    frontmatter.push(`max_iterations: ${agent.max_iterations}`)
  }

  // tools
  if (agent.tools && agent.tools.length > 0) {
    frontmatter.push('tools:')
    agent.tools.forEach(tool => {
      frontmatter.push(`  - ${tool}`)
    })
  }

  // skills
  if (agent.skills && agent.skills.length > 0) {
    frontmatter.push('skills:')
    agent.skills.forEach(skill => {
      frontmatter.push(`  - ${skill}`)
    })
  }

  // handoffs
  if (agent.handoffs && agent.handoffs.length > 0) {
    frontmatter.push('handoffs:')
    agent.handoffs.forEach(handoff => {
      frontmatter.push(`  - ${handoff}`)
    })
  }

  // memory
  if (agent.memory?.enabled) {
    const memoryType = agent.memory.memory_type || 'episodic'
    frontmatter.push(`memory: ${memoryType}`)
  }

  // topology
  if (agent.topology) {
    frontmatter.push(`topology: ${agent.topology}`)
  }

  frontmatter.push('---')
  frontmatter.push('')

  // soul 作为 Markdown body
  const body = agent.soul || `# ${agent.name}\n\n${agent.description || ''}`
  frontmatter.push(body)

  return frontmatter.join('\n')
}

/**
 * 主转换函数
 */
async function convertAgents() {
  try {
    const entries = await fs.readdir(AGENTS_DIR, { withFileTypes: true })
    
    const jsonFiles = entries.filter(
      entry => entry.isFile() && entry.name.endsWith('.json')
    )

    if (jsonFiles.length === 0) {
      console.log('✅ 没有需要转换的 JSON 文件')
      return
    }

    console.log(`🔄 发现 ${jsonFiles.length} 个 JSON 文件需要转换...\n`)

    for (const entry of jsonFiles) {
      const jsonPath = join(AGENTS_DIR, entry.name)
      const agentName = entry.name.replace('.json', '')
      const mdPath = join(AGENTS_DIR, `${agentName}.md`)

      try {
        // 读取 JSON 文件
        const content = await fs.readFile(jsonPath, 'utf-8')
        const agent = JSON.parse(content)

        // 转换为 Markdown
        const markdown = convertToJson(agent)

        // 写入 Markdown 文件
        await fs.writeFile(mdPath, markdown, 'utf-8')

        console.log(`✅ ${entry.name} → ${agentName}.md`)
      } catch (err) {
        console.error(`❌ 转换 ${entry.name} 失败:`, err.message)
      }
    }

    console.log('\n✨ 转换完成！')
    console.log('💡 建议：')
    console.log('   1. 检查生成的 .md 文件是否正确')
    console.log('   2. 确认无误后可以删除旧的 .json 文件')
    console.log('   3. 重启应用以加载新的 Markdown 格式 agents')
  } catch (err) {
    console.error('❌ 转换失败:', err.message)
    process.exit(1)
  }
}

// 运行转换
convertAgents()
