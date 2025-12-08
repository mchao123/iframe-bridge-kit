import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['src/index.ts', 'src/vite.ts'],
    format: ['cjs', 'esm'], // 同时输出 CommonJS 和 ES Module
    dts: true, // 自动生成类型定义文件
    clean: true,
    external: ['typescript', 'vite'], // 外部化这些依赖
    noExternal: [], // 确保其他依赖正常打包
    outDir: 'dist',
})

