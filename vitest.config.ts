import { defineConfig } from 'vitest/config'

export default defineConfig({
  server: {
    sourcemapIgnoreList: () => true,
  },
  test: {
    include: ['tests/**/*.{spec,test}.{ts,tsx}'],
    pool: 'threads',
    server: {
      deps: {
        inline: [/@deepseek-ai\//],
      },
    },
  },
})