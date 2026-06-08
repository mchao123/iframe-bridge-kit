import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['src/core.ts', 'src/parent-core.ts'],
    format: ['cjs', 'esm'],
    external: ['typescript', 'vite'], // 外部化这些依赖
    noExternal: ['penpal'], // 确保其他依赖正常打包
    splitting: false,
    clean: true,
    outDir: 'dist/full',
    minify: true,
    minifyIdentifiers: true,
    minifyWhitespace: true,
    minifySyntax: true,
})

