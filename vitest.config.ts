import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Full-world movement tests integrate thousands of fixed ticks across
    // 448 collision bodies. Keep assertions strict while giving CI enough
    // wall-clock time for the intentionally bounded spatial checks.
    testTimeout: 30_000
  }
})
