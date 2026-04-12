/**
 * sidecar/global.d.ts
 *
 * 为 sidecar 模式下的全局变量提供 TypeScript 类型声明。
 *
 * 这些变量是 bun:bundle 编译时宏的运行时垫片：
 * - MACRO: 编译时常量（版本号、构建时间等）
 * - feature: 条件编译函数
 */

// 扩展 globalThis 类型
declare global {
  /**
   * MACRO 编译时常量
   *
   * 这些值在 bun build 编译时被替换为实际值。
   * sidecar 模式下提供运行时垫片，避免编译错误。
   */
  var MACRO: {
    VERSION: string
    BUILD_TIME: string
    FEEDBACK_CHANNEL: string
    ISSUES_EXPLAINER: string
    NATIVE_PACKAGE_URL: string
    PACKAGE_URL: string
    VERSION_CHANGELOG: string
    USER_TYPE: string
  }

  /**
   * feature 条件编译函数
   *
   * 用于在编译时启用/禁用特定功能。
   * sidecar 模式下始终返回 false（禁用所有特性）。
   *
   * @param name 特性名称
   * @returns 是否启用该特性
   */
  var feature: (name: string) => boolean
}

// 导出空对象使此文件成为模块
export {}
