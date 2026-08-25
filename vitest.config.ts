import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    // src/shared is pure by contract. A DOM here would let a test depend on
    // `document` and hide a boundary violation, so there deliberately is none.
    environment: 'node',
    include: ['src/shared/**/*.test.ts']
  }
})
