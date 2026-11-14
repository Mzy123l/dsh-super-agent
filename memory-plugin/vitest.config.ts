import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/ingest/extractor.ts', 'src/ingest/log-reader.ts', 'src/store/sqlite.ts', 'src/search/**/*.ts'],
      thresholds: {
        // 规格 §6 验收 7：store/extractor/search 三模块覆盖率 ≥80%
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
})
