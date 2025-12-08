import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['src/core.ts'],
    format: ['cjs', 'esm'],
    external: ['typescript', 'vite'], // 外部化这些依赖
    noExternal: [], // 确保其他依赖正常打包
    clean: true,
    outDir: 'dist/mini',
    minify: true,
    minifyIdentifiers: true,
    minifyWhitespace: true,
    minifySyntax: true,
})

