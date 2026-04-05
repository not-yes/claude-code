# Claude Code 泄露源码分析

这次泄露源于一个 59.8 MB 的 JavaScript 源映射文件（Source Map）`cli.js.map`，它意外地被包含在 npm 仓库的 2.1.88 版本中。

## 泄露背景：一次“昂贵”的人为失误

Anthropic 的工程师在发布新版本时，由于 `.npmignore` 文件配置错误或打包脚本失误，将用于内部调试的源映射文件公之于众。该文件允许开发者将压缩后的代码还原为 51.2 万行(1906个源文件，总计517859行代码) unobfuscated（未混淆）的 TypeScript 源码。尽管 Anthropic 随后撤回了该版本，但代码已被社区广泛镜像。
