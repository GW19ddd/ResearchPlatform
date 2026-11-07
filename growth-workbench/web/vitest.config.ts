import { defineConfig } from 'vitest/config'

export default defineConfig({
  // SSR 转译缓存默认写系统临时目录，被本环境 fs 代理拦截（EPERM），导致测试文件间歇丢失。
  // 指到工作区内的 node_modules 子目录即可正常写入。
  cacheDir: 'node_modules/.vitest-cache',
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    cache: { dir: 'node_modules/.vitest-cache' },
  },
})
