/**
 * build-sidecar.ts
 *
 * 跨平台 Sidecar 编译脚本。
 * 将 src/sidecar/entry.ts 编译为原生可执行文件，
 * 输出到 frontend/src-tauri/binaries/ 目录。
 *
 * 用法：
 *   bun scripts/build-sidecar.ts                        # 自动检测当前平台
 *   bun scripts/build-sidecar.ts --target bun-darwin-arm64
 *   bun scripts/build-sidecar.ts --target bun-linux-x64
 */

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { parseArgs } from 'node:util'
import path from 'node:path'

// ─── 平台映射表 ────────────────────────────────────────────────────────────────

interface PlatformInfo {
  triple: string  // Tauri TARGET_TRIPLE
  ext: string     // 可执行文件扩展名（Windows 为 .exe，其他为空）
}

const PLATFORM_MAP: Record<string, PlatformInfo> = {
  'bun-darwin-arm64': { triple: 'aarch64-apple-darwin',       ext: '' },
  'bun-darwin-x64':   { triple: 'x86_64-apple-darwin',        ext: '' },
  'bun-linux-x64':    { triple: 'x86_64-unknown-linux-gnu',   ext: '' },
  'bun-linux-arm64':  { triple: 'aarch64-unknown-linux-gnu',  ext: '' },
  'bun-windows-x64':  { triple: 'x86_64-pc-windows-msvc',     ext: '.exe' },
}

// ─── 自动检测当前平台 ───────────────────────────────────────────────────────────

function detectCurrentPlatform(): string {
  const os = process.platform
  const arch = process.arch

  if (os === 'darwin' && arch === 'arm64') return 'bun-darwin-arm64'
  if (os === 'darwin' && arch === 'x64')   return 'bun-darwin-x64'
  if (os === 'linux'  && arch === 'x64')   return 'bun-linux-x64'
  if (os === 'linux'  && arch === 'arm64') return 'bun-linux-arm64'
  if (os === 'win32'  && arch === 'x64')   return 'bun-windows-x64'

  throw new Error(
    `不支持的平台: ${os}/${arch}。` +
    `请手动指定 --target 参数（可选值: ${Object.keys(PLATFORM_MAP).join(', ')}）`
  )
}

// ─── 格式化文件大小 ─────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`
  }
  return `${bytes} B`
}

// ─── 主函数 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. 解析命令行参数
  const { values } = parseArgs({
    args: Bun.argv,
    options: {
      target: { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
  })

  // 2. 确定目标平台
  const bunTarget = values.target ?? detectCurrentPlatform()

  const platformInfo = PLATFORM_MAP[bunTarget]
  if (!platformInfo) {
    console.error(`[错误] 未知的 target: "${bunTarget}"`)
    console.error(`可选值: ${Object.keys(PLATFORM_MAP).join(', ')}`)
    process.exit(1)
  }

  const { triple, ext } = platformInfo

  // 3. 确定输入/输出路径
  const scriptDir = path.dirname(Bun.fileURLToPath(import.meta.url))
  const projectRoot = path.resolve(scriptDir, '..')
  const entrypoint = path.resolve(projectRoot, 'src/sidecar/entry.ts')
  const binDir = path.resolve(projectRoot, '../frontend/src-tauri/binaries')
  const outfile = path.join(binDir, `claude-sidecar-${triple}${ext}`)

  // 4. 确保输出目录存在
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true })
    console.info(`[信息] 已创建输出目录: ${binDir}`)
  }

  // 5. 打印构建信息
  console.info('')
  console.info('╔═══════════════════════════════════════════════════╗')
  console.info('║           Claude Sidecar 编译器                   ║')
  console.info('╚═══════════════════════════════════════════════════╝')
  console.info(`  目标平台   : ${bunTarget}`)
  console.info(`  TARGET_TRIPLE: ${triple}`)
  console.info(`  入口文件   : ${entrypoint}`)
  console.info(`  输出路径   : ${outfile}`)
  console.info('')

  // 6. 执行编译
  const startTime = Date.now()

  console.info('[步骤] 开始编译...')

  const proc = Bun.spawnSync(
    [
      'bun', 'build',
      './src/sidecar/entry.ts',
      '--compile',
      `--target=${bunTarget}`,
      '--minify',
      `--outfile=${outfile}`,
      '--define', 'process.env.SIDECAR_MODE="true"',
      '--define', 'process.env.NODE_ENV="production"',
      // playwright-core 的可选/动态依赖，静态编译时无法解析，标记为 external 跳过
      '--external', 'chromium-bidi',
      '--external', 'chromium-bidi/lib/cjs/bidiMapper/BidiMapper',
      '--external', 'chromium-bidi/lib/cjs/cdp/CdpConnection',
      '--external', 'electron',
    ],
    {
      cwd: projectRoot,
      stdout: 'inherit',
      stderr: 'inherit',
    }
  )

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)

  // 7. 检查结果
  if (proc.exitCode !== 0) {
    console.error(`\n[错误] 编译失败（退出码: ${proc.exitCode}）`)
    process.exit(proc.exitCode ?? 1)
  }

  // 8. 输出统计信息
  let sizeStr = '未知'
  if (existsSync(outfile)) {
    const stat = statSync(outfile)
    sizeStr = formatSize(stat.size)
  }

  console.info('')
  console.info('╔═══════════════════════════════════════════════════╗')
  console.info('║                编译完成 ✓                         ║')
  console.info('╚═══════════════════════════════════════════════════╝')
  console.info(`  输出路径   : ${outfile}`)
  console.info(`  文件大小   : ${sizeStr}`)
  console.info(`  编译耗时   : ${elapsed}s`)
  console.info('')
}

main().catch(err => {
  console.error('[FATAL] 脚本执行失败:', err instanceof Error ? err.message : String(err))
  if (err instanceof Error && err.stack) {
    console.error(err.stack)
  }
  process.exit(1)
})
