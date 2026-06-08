import type { Plugin, ViteDevServer } from 'vite'
import * as ts from 'typescript'
import * as path from 'path'
import * as fs from 'fs'
import packageJson from '../package.json'

export interface IframeBridgeOptions {
    /** 输出目录，默认为 'bridges' */
    outDir?: string
    /** 完整模式，默认为true */
    full?: boolean
    /** 脚本的允许域，默认为 ['*'] */
    allowedOrigins?: string[]
    /** 
     * 保留这些模块的类型导入而不是展开
     * 例如: ['vue', '@vueuse/core'] 
     * 使用这些模块的类型会生成 import type { X } from 'vue' 的形式
     */
    preserveModules?: string[]
}

interface MethodInfo {
    name: string
    params: string
    returnType: string
    jsdoc?: string // JSDoc 注释
}

interface BridgeInfo {
    name: string
    target: 'child' | 'parent'
    methods: MethodInfo[]
    sourceFile: string
    typeDeclarations: { name: string; content: string }[] // Changed to structured info
    imports: Map<string, Set<string>> // 模块名 (absolute or package) -> 导入的类型名集合
    emitMap?: { name: string; type: string }[]
    emitTypeName?: string
}

const packageName = packageJson.name

/**
 * 从 .vue 文件中提取 <script> 或 <script setup> 标签的内容
 */
function extractScriptFromVue(code: string): { script: string; lang: string; startLine: number } | null {
    const scriptRegex = /<script(?:\s+setup)?(?:\s+lang\s*=\s*["']?(ts|typescript)["']?)?[^>]*>([\s\S]*?)<\/script>/i
    const match = code.match(scriptRegex)

    if (match) {
        const lang = match[1] || 'js'
        const script = match[2] || ''
        // 计算 script 开始的行号
        const beforeScript = code.substring(0, match.index! + match[0].indexOf('>') + 1)
        const startLine = beforeScript.split('\n').length
        return { script, lang, startLine }
    }

    return null
}

/**
 * 创建一个 TypeScript Program 来进行类型检查
 * 使用临时文件方式确保跨文件类型可以被正确解析
 */
function createTypeCheckerProgram(code: string, filePath: string): { program: ts.Program; sourceFile: ts.SourceFile | undefined; cleanup: () => void } {
    // 规范化路径（使用正斜杠）
    const normalizedPath = filePath.replace(/\\/g, '/')

    // 对于 .vue 文件，创建一个临时 .ts 文件在同一目录
    const isVueFile = normalizedPath.endsWith('.vue')
    const tempFileName = isVueFile
        ? normalizedPath.replace('.vue', '.__bridge_temp__.ts')
        : normalizedPath + '.__bridge_temp__.ts'

    // 写入临时文件
    let needsCleanup = false
    if (isVueFile) {
        try {
            fs.writeFileSync(tempFileName, code, 'utf-8')
            needsCleanup = true
        } catch (err) {
            console.error(`[iframe-bridge] Failed to write temp file: ${tempFileName}`, err)
        }
    }

    const cleanup = () => {
        if (needsCleanup && fs.existsSync(tempFileName)) {
            try {
                fs.unlinkSync(tempFileName)
            } catch (err) {
                // 忽略清理错误
            }
        }
    }

    // 读取 tsconfig.json
    const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json')
    let compilerOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
    }

    if (configPath) {
        const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
        if (configFile.config) {
            const parsed = ts.parseJsonConfigFileContent(
                configFile.config,
                ts.sys,
                path.dirname(configPath)
            )
            compilerOptions = { ...compilerOptions, ...parsed.options }
        }
    }

    const targetFile = isVueFile ? tempFileName : normalizedPath

    // 使用标准方式创建 Program
    const program = ts.createProgram([targetFile], compilerOptions)
    const sourceFile = program.getSourceFile(targetFile)

    return { program, sourceFile, cleanup }
}


/**
 * 使用 TypeChecker 获取类型的字符串表示（展开类型别名）
 */
function getTypeString(checker: ts.TypeChecker, type: ts.Type, inTypeAlias?: boolean): string {

    return inTypeAlias ?
        checker.typeToString(type, undefined,
            ts.TypeFormatFlags.NoTruncation |
            ts.TypeFormatFlags.InTypeAlias |  // 强制展开类型别名
            ts.TypeFormatFlags.UseFullyQualifiedType |
            ts.TypeFormatFlags.WriteArrayAsGenericType
        )
        :
        checker.typeToString(
            type,
            undefined,
            ts.TypeFormatFlags.NoTruncation |
            ts.TypeFormatFlags.UseFullyQualifiedType |
            ts.TypeFormatFlags.WriteArrayAsGenericType
        )
}

/**
 * 提取节点的 JSDoc 注释
 */
function getJsDoc(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
    const jsDocs = ts.getJSDocCommentsAndTags(node)
    if (jsDocs.length === 0) {
        return undefined
    }

    // 获取完整的 JSDoc 文本
    const fullText = sourceFile.getFullText()
    const comments: string[] = []

    for (const jsDoc of jsDocs) {
        if (ts.isJSDoc(jsDoc)) {
            // 获取 JSDoc 的原始文本
            const start = jsDoc.getStart(sourceFile)
            const end = jsDoc.getEnd()
            const text = fullText.substring(start, end)
            comments.push(text)
        }
    }

    return comments.length > 0 ? comments.join('\n') : undefined
}


/**
 * 解析代码并提取 bridge 信息（使用完整的类型检查器）
 */
function parseBridgeFromCode(code: string, filePath: string): { results: BridgeInfo[], cleanup: () => void } {
    const results: BridgeInfo[] = []
    let cleanup = () => { }


    let scriptCode = code
    const isVueFile = filePath.endsWith('.vue')

    // 处理 .vue 文件
    if (isVueFile) {
        const extracted = extractScriptFromVue(code)
        if (!extracted || (extracted.lang !== 'ts' && extracted.lang !== 'typescript')) {
            return { results, cleanup }
        }
        scriptCode = extracted.script
    }

    // 创建带类型检查器的 Program
    const { program, sourceFile, cleanup: programCleanup } = createTypeCheckerProgram(scriptCode, filePath)
    cleanup = programCleanup

    if (!sourceFile) {
        console.warn(`[iframe-bridge] Could not parse source file: ${filePath}`)
        return { results, cleanup }
    }

    const checker = program.getTypeChecker()

    // Step 0.5: 收集所有类型声明（type 和 interface）及其依赖
    const typeDeclarations: { name: string; content: string }[] = []
    const typeImports = new Map<string, Set<string>>()

    const collectTypeImports = (node: ts.Node) => {
        if (ts.isIdentifier(node)) {
            const symbol = checker.getSymbolAtLocation(node)
            if (symbol && symbol.declarations && symbol.declarations.length > 0) {
                const decl = symbol.declarations[0]
                if (ts.isImportSpecifier(decl)) {
                    // declaration -> NamedImports -> ImportClause -> ImportDeclaration
                    const importDecl = decl.parent.parent.parent
                    if (ts.isImportDeclaration(importDecl) && ts.isStringLiteral(importDecl.moduleSpecifier)) {
                        let modulePath = importDecl.moduleSpecifier.text
                        // 尝试获取绝对路径
                        const moduleSymbol = checker.getSymbolAtLocation(importDecl.moduleSpecifier)
                        if (moduleSymbol) {
                            const decls = moduleSymbol.getDeclarations()
                            if (decls && decls.length > 0 && ts.isSourceFile(decls[0])) {
                                modulePath = decls[0].fileName
                            }
                        }

                        const propertyName = decl.propertyName?.text
                        const name = decl.name.text
                        const importStr = propertyName ? `${propertyName} as ${name}` : name

                        if (!typeImports.has(modulePath)) {
                            typeImports.set(modulePath, new Set())
                        }
                        typeImports.get(modulePath)!.add(importStr)
                    }
                }
            }
        }
        ts.forEachChild(node, collectTypeImports)
    }

    for (const stmt of sourceFile.statements) {
        if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) {
            typeDeclarations.push({
                name: stmt.name.text,
                content: stmt.getText(sourceFile)
            })
            collectTypeImports(stmt)
        }
    }

    // Step 1: 查找从 iframe-bridge-kit 导入的 bridge 定义函数的本地名称
    const bridgeFactories = new Map<string, BridgeInfo['target']>()

    for (const stmt of sourceFile.statements) {
        if (
            ts.isImportDeclaration(stmt) &&
            ts.isStringLiteral(stmt.moduleSpecifier) &&
            stmt.moduleSpecifier.text === packageName
        ) {
            const namedBindings = stmt.importClause?.namedBindings
            if (namedBindings && ts.isNamedImports(namedBindings)) {
                for (const element of namedBindings.elements) {
                    const originalName = element.propertyName?.text ?? element.name.text
                    if (originalName === 'defineBridge') {
                        bridgeFactories.set(element.name.text, 'child')
                    }
                    if (originalName === 'defineIframeBridge') {
                        bridgeFactories.set(element.name.text, 'parent')
                    }
                }
            }
        }
    }

    if (bridgeFactories.size === 0) {
        return { results, cleanup }
    }

    // Step 2: 遍历 AST 查找 bridge 定义调用
    const visit = (node: ts.Node) => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            bridgeFactories.has(node.expression.text)
        ) {
            const target = bridgeFactories.get(node.expression.text)!
            const [nameArg, methodsArg] = node.arguments

            // 提取 name
            if (!nameArg || !ts.isStringLiteral(nameArg)) {
                return
            }
            const bridgeName = nameArg.text

            // 提取 methods 对象
            if (!methodsArg || !ts.isObjectLiteralExpression(methodsArg)) {
                return
            }

            const methods: MethodInfo[] = []

            for (const prop of methodsArg.properties) {
                let methodName: string | null = null
                let params = ''
                let returnType = 'void'
                let jsdoc: string | undefined = undefined

                if (ts.isMethodDeclaration(prop)) {
                    // 方法声明形式: { foo(a: number): string {} }
                    methodName = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null
                    if (!methodName) continue

                    const signature = checker.getSignatureFromDeclaration(prop)
                    if (signature) {
                        const paramStrings = prop.parameters.map(p => {
                            const paramName = p.name.getText(sourceFile)
                            const paramSymbol = checker.getSymbolAtLocation(p.name)
                            let paramType = 'unknown'
                            if (paramSymbol) {
                                const type = checker.getTypeOfSymbolAtLocation(paramSymbol, p)
                                paramType = getTypeString(checker, type)
                            } else if (p.type) {
                                paramType = p.type.getText(sourceFile)
                            }
                            const optional = p.questionToken ? '?' : ''
                            return `${paramName}${optional}: ${paramType}`
                        })
                        params = paramStrings.join(', ')
                        const retType = signature.getReturnType()
                        returnType = getTypeString(checker, retType)
                    }
                    jsdoc = getJsDoc(prop, sourceFile)

                } else if (ts.isPropertyAssignment(prop)) {
                    // 属性赋值形式: { foo: (a: number) => string }
                    methodName = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null
                    if (!methodName) continue

                    const init = prop.initializer
                    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
                        const signature = checker.getSignatureFromDeclaration(init)
                        if (signature) {
                            const paramStrings = init.parameters.map(p => {
                                const paramName = p.name.getText(sourceFile)
                                const paramSymbol = checker.getSymbolAtLocation(p.name)
                                let paramType = 'unknown'
                                if (paramSymbol) {
                                    const type = checker.getTypeOfSymbolAtLocation(paramSymbol, p)
                                    paramType = getTypeString(checker, type)
                                } else if (p.type) {
                                    paramType = p.type.getText(sourceFile)
                                }
                                const optional = p.questionToken ? '?' : ''
                                return `${paramName}${optional}: ${paramType}`
                            })
                            params = paramStrings.join(', ')
                            const retType = signature.getReturnType()
                            returnType = getTypeString(checker, retType)
                        }
                    }
                    jsdoc = getJsDoc(prop, sourceFile)

                } else if (ts.isShorthandPropertyAssignment(prop)) {
                    // 简写属性形式: { fn } (等价于 { fn: fn })
                    methodName = prop.name.text

                    // 获取引用的变量的类型
                    const symbol = checker.getSymbolAtLocation(prop.name)
                    if (symbol) {
                        const type = checker.getTypeOfSymbolAtLocation(symbol, prop)
                        const callSignatures = type.getCallSignatures()

                        if (callSignatures.length > 0) {
                            const signature = callSignatures[0]

                            // 获取参数
                            const paramStrings = signature.getParameters().map(param => {
                                const paramType = checker.getTypeOfSymbolAtLocation(param, prop)
                                const paramName = param.getName()
                                return `${paramName}: ${getTypeString(checker, paramType)}`
                            })
                            params = paramStrings.join(', ')

                            // 获取返回类型
                            const retType = signature.getReturnType()
                            returnType = getTypeString(checker, retType)
                        }
                    }

                    // 尝试获取原始变量定义处的 JSDoc
                    // 首先尝试获取简写属性本身的 JSDoc
                    jsdoc = getJsDoc(prop, sourceFile)

                    // 如果没有，尝试获取原始变量声明的 JSDoc
                    if (!jsdoc && symbol && symbol.valueDeclaration) {
                        jsdoc = getJsDoc(symbol.valueDeclaration, sourceFile)
                    }
                }

                if (methodName) {
                    methods.push({
                        name: methodName,
                        params,
                        returnType,
                        jsdoc
                    })
                }
            }

            const emitMap: { name: string; type: string }[] = []
            let emitTypeName: string | undefined
            if (node.typeArguments && node.typeArguments.length > 0) {
                const emitTypeNode = node.typeArguments[0]
                if (ts.isTypeReferenceNode(emitTypeNode) && ts.isIdentifier(emitTypeNode.typeName)) {
                    emitTypeName = emitTypeNode.typeName.text
                }
                const emitType = checker.getTypeFromTypeNode(emitTypeNode)

                emitType.getProperties().forEach(prop => {
                    const name = prop.getName()
                    let type = 'any'
                    // For property signature, type can be obtained via getTypeOfSymbol
                    const propType = checker.getTypeOfSymbolAtLocation(prop, node)
                    type = getTypeString(checker, propType)

                    emitMap.push({ name, type })
                })
            }

            const bridgeImports = new Map<string, Set<string>>()
            mergeImports(bridgeImports, typeImports)

            results.push({
                name: bridgeName,
                target,
                methods,
                sourceFile: filePath,
                typeDeclarations,
                imports: bridgeImports,
                emitMap,
                emitTypeName
            })
        }

        ts.forEachChild(node, visit)
    }

    ts.forEachChild(sourceFile, visit)

    return { results, cleanup }
}

/**
 * 从文件中提取导出的类型定义
 */
function extractTypeExport(filePath: string, typeName: string): string | null {
    if (!fs.existsSync(filePath)) return null
    try {
        const code = fs.readFileSync(filePath, 'utf-8')
        const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true)

        let result: string | null = null

        // 查找导出的类型
        ts.forEachChild(sourceFile, node => {
            if (result) return

            if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
                // Check name. We trust the file contains the export because it was resolved from an import.
                if (node.name?.text === typeName) {
                    let text = node.getText(sourceFile)

                    // Helper to clean up modifiers
                    // Remove 'export'
                    text = text.replace(/^\s*export\s+/, '')
                    // Remove 'declare'
                    text = text.replace(/^\s*declare\s+/, '')

                    // If it's a class, we keep it as is (it acts as a type). 
                    // In d.ts class is basically an interface with constructor.

                    result = text
                }
            }
        })

        return result
    } catch (e) {
        return null
    }
}

/**
 * 处理类型字符串中的导入路径
 * 将绝对路径转换为相对路径
 */
type CopiedTypeRegistry = Map<string, { uniqueName: string, definition: string }>

function processTypeString(
    typeStr: string,
    outDir: string,
    registry: CopiedTypeRegistry,
    preserveModules: string[] = []
): {
    processed: string
    imports: Map<string, Set<string>>
} {
    const imports = new Map<string, Set<string>>()
    // const copiedTypes = new Map<string, string>() // Remove local map
    const outputDir = path.resolve(process.cwd(), outDir)

    // 匹配 import("...").TypeName 模式
    const importPattern = /import\("([^"]+)"\)\.(\w+)/g

    const processed = typeStr.replace(importPattern, (match, importPath, typeName) => {
        // 规范化路径
        let normalizedPath = importPath.replace(/\\/g, '/')

        // 尝试检测是否来自 node_modules
        // 使用更稳健的方式检测 (查找 /node_modules/)
        const nodeModulesIndex = normalizedPath.lastIndexOf('/node_modules/')
        const isNodeModule = nodeModulesIndex !== -1

        if (isNodeModule) {
            // 提取模块名
            const afterNodeModules = normalizedPath.substring(nodeModulesIndex + 14) // Length of '/node_modules/'
            const parts = afterNodeModules.split('/')
            let moduleName = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]

            // 检查 preserveModules
            let shouldPreserve = preserveModules.some(m => moduleName === m || moduleName.startsWith(m + '/'))

            // 特殊处理 Vue 生态
            // 如果 'vue' 在保留列表中，且模块是 @vue/*，则保留并重映射为 'vue'
            if (preserveModules.includes('vue') && moduleName.startsWith('@vue/')) {
                shouldPreserve = true
                moduleName = 'vue'
            }

            if (shouldPreserve) {
                // 添加到导入集合
                if (!imports.has(moduleName)) {
                    imports.set(moduleName, new Set())
                }
                imports.get(moduleName)!.add(typeName)

                return typeName
            }

            // 如果没有保留，则继续执行后续逻辑，尝试解构（拷贝定义）
            // 这意味着 node_modules 中的类型默认会被展开，除非在 preserveModules 中指定
        }

        // 2. 本地文件 OR 未保留的 node_modules - 尝试提取定义
        let absoluteImportPath = normalizedPath
        if (!fs.existsSync(absoluteImportPath) && !absoluteImportPath.endsWith('.ts')) {
            if (fs.existsSync(absoluteImportPath + '.ts')) {
                absoluteImportPath += '.ts'
            } else if (fs.existsSync(absoluteImportPath + '.d.ts')) {
                absoluteImportPath += '.d.ts'
            }
        }

        // 构造唯一键
        const registryKey = `${absoluteImportPath}::${typeName}`

        if (registry.has(registryKey)) {
            return registry.get(registryKey)!.uniqueName
        }

        // 尝试提取
        const definition = extractTypeExport(absoluteImportPath, typeName)

        if (definition) {
            // 生成唯一名称
            const uniqueSuffix = Math.random().toString(36).substring(2, 8)
            const uniqueName = `${typeName}_${uniqueSuffix}`

            // 重命名定义中的类型名
            // 匹配单词边界，且不紧跟 冒号 或 左括号 (排除属性名和方法名)
            // 这是一个启发式替换，可能不是 100% 完美，但对大多数情况有效
            const renameRegex = new RegExp(`\\b${typeName}\\b(?!\\s*[:(])`, 'g')
            const renamedDefinition = definition.replace(renameRegex, uniqueName)

            registry.set(registryKey, {
                uniqueName,
                definition: renamedDefinition
            })

            return uniqueName
        }

        // 如果提取失败，回退到 Import (使用相对路径)
        const relativeFromOutput = path.relative(outputDir, absoluteImportPath).replace(/\\/g, '/')

        // 移除 .ts/.d.ts 扩展名
        const cleanPath = relativeFromOutput.replace(/(\.d)?\.ts$/, '').replace(/\.vue$/, '')

        // 确保以 ./ 开头
        const finalPath = cleanPath.startsWith('.') ? cleanPath : './' + cleanPath

        // 添加到导入集合（使用相对路径作为模块名）
        if (!imports.has(finalPath)) {
            imports.set(finalPath, new Set())
        }
        imports.get(finalPath)!.add(typeName)

        return typeName
    })

    return { processed, imports }
}

/**
 * 合并多个导入 Map
 */
function mergeImports(target: Map<string, Set<string>>, source: Map<string, Set<string>>): void {
    for (const [mod, types] of source) {
        if (!target.has(mod)) {
            target.set(mod, new Set())
        }
        for (const t of types) {
            target.get(mod)!.add(t)
        }
    }
}

/**
 * 生成 .d.ts 文件内容
 */
/**
 * 生成 .d.ts 文件内容
 */
function generateDtsContent(info: BridgeInfo, outDir: string, preserveModules: string[] = []): string {
    const allImports = new Map<string, Set<string>>()
    const registry: CopiedTypeRegistry = new Map()
    const outputDir = path.resolve(process.cwd(), outDir)



    // 处理收集到的 imports (来自 typeDeclarations)
    if (info.imports) {
        for (const [pathKey, types] of info.imports) {
            let normalizedPath = pathKey.replace(/\\/g, '/')

            // 复用 processTypeString 的路径处理逻辑
            // TODO: 最好提取公共逻辑
            if (normalizedPath.includes('/node_modules/')) {
                const index = normalizedPath.lastIndexOf('/node_modules/')
                const after = normalizedPath.substring(index + 14)
                const parts = after.split('/')
                let mod = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]

                if (allImports.has(mod)) {
                    types.forEach(t => allImports.get(mod)!.add(t))
                } else {
                    allImports.set(mod, new Set(types))
                }
            } else if (path.isAbsolute(normalizedPath)) {
                // 计算相对路径
                const rel = path.relative(outputDir, normalizedPath).replace(/\\/g, '/')
                const clean = rel.replace(/(\.d)?\.ts$/, '').replace(/\.vue$/, '')
                const final = clean.startsWith('.') ? clean : './' + clean
                if (allImports.has(final)) {
                    types.forEach(t => allImports.get(final)!.add(t))
                } else {
                    allImports.set(final, new Set(types))
                }
            } else {
                // 已经是相对路径或包名 (fallback)
                if (allImports.has(normalizedPath)) {
                    types.forEach(t => allImports.get(normalizedPath)!.add(t))
                } else {
                    allImports.set(normalizedPath, new Set(types))
                }
            }
        }
    }

    // 处理所有方法的类型字符串
    const processedMethods = info.methods.map(m => {
        const resultParams = processTypeString(m.params, outDir, registry, preserveModules)
        const resultReturn = processTypeString(m.returnType, outDir, registry, preserveModules)

        mergeImports(allImports, resultParams.imports)
        mergeImports(allImports, resultReturn.imports)

        return {
            ...m,
            params: resultParams.processed,
            returnType: resultReturn.processed.startsWith('Promise') ? resultReturn.processed : `Promise<${resultReturn.processed}>`
        }
    })

    const emitMap = info.emitMap || []
    const processedEmitTypes = emitMap.map(e => {
        const res = processTypeString(e.type, outDir, registry, preserveModules)
        mergeImports(allImports, res.imports)
        return { name: e.name, type: res.processed }
    })


    const lines: string[] = [
        '// Auto-generated by vite-plugin-iframe-bridge',
        '// Do not edit this file manually',
        ''
    ]

    // 生成导入语句
    if (allImports.size > 0) {
        for (const [mod, types] of allImports) {
            const typeList = Array.from(types).sort().join(', ')
            lines.push(`import type { ${typeList} } from '${mod}';`)
        }
        lines.push('')
    }

    // 添加拷贝的类型定义 (从 Registry)
    if (registry.size > 0) {
        lines.push('// Copied type definitions')
        // 排序输出以保持稳定
        const sortedDefs = Array.from(registry.values()).sort((a, b) => a.uniqueName.localeCompare(b.uniqueName))

        for (const { definition } of sortedDefs) {
            lines.push(definition)
            lines.push('')
        }
    }

    const localTypeDeclarations = info.typeDeclarations.filter(({ name }) => name !== info.emitTypeName && name !== 'EmitMap')

    if (localTypeDeclarations.length > 0) {
        lines.push('// Local type definitions')
        for (const { content } of localTypeDeclarations) {
            lines.push(content)
            lines.push('')
        }
    }

    if (info.target === 'parent') {
        if (processedEmitTypes.length > 0) {
            lines.push('export interface EmitMap {')
            processedEmitTypes.forEach(e => {
                lines.push(`    "${e.name}": ${e.type};`)
            })
            lines.push('}')
            lines.push('')
        }

        lines.push('export interface BridgeConnection {')
        lines.push('    api: {')
        lines.push(
            ...processedMethods
                .map(m =>
                    (m.jsdoc ? `        ${m.jsdoc}\n` : '') +
                    `        ${m.name}: (${m.params}) => ${m.returnType},`
                )
        )
        lines.push('    };')

        if (processedEmitTypes.length > 0) {
            lines.push('    onMessage<K extends keyof EmitMap>(type: K, cb: (data: EmitMap[K]) => void, once?: boolean): () => void;')
            lines.push('    onMessage(type: string, cb: Function, once?: boolean): () => void;')
            lines.push('    offMessage<K extends keyof EmitMap>(type: K, fn?: (data: EmitMap[K]) => void): void;')
            lines.push('    offMessage(type: string, fn?: Function): void;')
        } else {
            lines.push('    onMessage(type: string, cb: Function, once?: boolean): () => void;')
            lines.push('    offMessage(type: string, fn?: Function): void;')
        }

        lines.push('    isInit(): boolean;')
        lines.push('    onInit(cb: Function): void;')
        lines.push('    destroy(): void;')
        lines.push('}')
        lines.push('')
        lines.push('export declare function create(iframe: HTMLIFrameElement, allowedOrigins?: string[]): BridgeConnection;')
        lines.push('declare const bridge: { create: typeof create };')
        lines.push('export default bridge;')
        lines.push('')

        return lines.join('\n')
    }

    if (processedEmitTypes.length > 0) {
        lines.push('export interface EmitMap {')
        processedEmitTypes.forEach(e => {
            lines.push(`    "${e.name}": ${e.type};`)
        })
        lines.push('}')
        lines.push('')
        lines.push('export declare function onMessage<K extends keyof EmitMap>(type: K, cb: (data: EmitMap[K]) => void, once?: boolean): () => void;')
        lines.push('export declare function onMessage(type: string, cb: Function, once?: boolean): () => void;')
        lines.push('export declare function offMessage<K extends keyof EmitMap>(type: K, fn?: (data: EmitMap[K]) => void): void;')
        lines.push('export declare function offMessage(type: string, fn?: Function): void;')
    } else {
        lines.push('export declare function onMessage(type: string, cb: Function, once?: boolean): () => void;')
        lines.push('export declare function offMessage(type: string, fn?: Function): void;')
    }

    lines.push('export declare function isInit(): boolean;')
    lines.push('export declare function onInit(cb: Function): void;')
    lines.push('')

    lines.push(`export default {} as {`)
    lines.push(
        ...processedMethods
            .map(m =>
                (m.jsdoc ? `    ${m.jsdoc}\n` : '') +
                `    ${m.name}: (${m.params}) => ${m.returnType},`
            )
    )
    lines.push('}')
    lines.push('')

    return lines.join('\n')
}


/**
 * 写入类型文件
 */
function writeDtsFile(info: BridgeInfo, options: IframeBridgeOptions): void {
    const outDir = options.outDir || 'bridges'
    const absoluteOutDir = path.resolve(process.cwd(), outDir)


    const dtsContent = generateDtsContent(info, outDir, options.preserveModules)
    const dtsDir = path.join(absoluteOutDir, info.name)
    if (!fs.existsSync(dtsDir)) {
        fs.mkdirSync(dtsDir, { recursive: true })
    }
    fs.writeFileSync(path.join(dtsDir, 'index.d.ts'), dtsContent, 'utf-8')
    fs.writeFileSync(path.join(dtsDir, 'index.d.mts'), dtsContent, 'utf-8')
    console.log(`[iframe-bridge] Generated: ${dtsDir}`)
}


/**
 * 处理单个文件并生成类型
 */
function processFile(filePath: string, code: string, options: IframeBridgeOptions): BridgeInfo[] {
    // 检查是否包含 defineBridge
    if (!code.includes(packageName)) {
        return []
    }

    // 检查文件类型
    if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx') && !filePath.endsWith('.vue')) {
        return []
    }

    try {
        const { results: bridges, cleanup } = parseBridgeFromCode(code, filePath)

        // 立即写入类型文件和运行时文件
        for (const bridge of bridges) {
            writeDtsFile(bridge, options)
            writeBridgeRuntime(bridge, options)
        }

        cleanup()
        return bridges
    } catch (err) {
        console.error(`[iframe-bridge] Error parsing ${filePath}:`, err)
        return []
    }
}

/**
 * 拷贝核心文件并替换配置
 */
/**
 * 拷贝核心文件到指定 bridge 目录并替换配置
 */
function writeBridgeRuntime(info: BridgeInfo, options: IframeBridgeOptions) {
    const isFull = options.full !== false
    const allowedOrigins = options.allowedOrigins || ['*']
    const outDir = options.outDir || 'bridges'

    // 定位 core 文件
    const variant = isFull ? 'full' : 'mini'

    // 尝试不同的路径策略
    const basePaths = [
        // 1. 假设我们在 dist 目录中运行
        path.resolve(__dirname, variant),
        // 2. 假设我们在 src 目录中运行
        path.resolve(__dirname, '../dist', variant),
    ]

    let coreDir = ''
    for (const p of basePaths) {
        if (fs.existsSync(p)) {
            coreDir = p
            break
        }
    }

    if (!coreDir) {
        return
    }

    // 目标目录
    const absoluteOutDir = path.resolve(process.cwd(), outDir, info.name)
    if (!fs.existsSync(absoluteOutDir)) {
        fs.mkdirSync(absoluteOutDir, { recursive: true })
    }

    // 需要复制的文件扩展名
    const extensions = ['js', 'mjs']
    const replaceContent = JSON.stringify(allowedOrigins).slice(1, - 1)
    const runtimeName = info.target === 'parent' ? 'parent-core' : 'core'

    for (const ext of extensions) {
        const srcFile = path.join(coreDir, `${runtimeName}.${ext}`)
        if (fs.existsSync(srcFile)) {
            try {
                let content = fs.readFileSync(srcFile, 'utf-8')

                // 替换 AllowedOrigins
                content = content.replace(/["']__AllowedOrigins__["']/g, replaceContent)

                // 写入 index.{ext}
                const destPath = path.join(absoluteOutDir, `index.${ext}`)
                fs.writeFileSync(destPath, content, 'utf-8')
            } catch (err) {
                console.error(`[iframe-bridge] Failed to copy core.${ext}:`, err)
            }
        }
    }
}

/**
 * 拷贝核心文件并替换配置 (Unused)
 */
function copyCoreFile_Unused(options: IframeBridgeOptions) {
    const isFull = options.full !== false
    const allowedOrigins = options.allowedOrigins || ['*']
    const outDir = options.outDir || 'bridges'

    // 定位 core 文件
    let corePath = ''
    const variant = isFull ? 'full' : 'mini'

    // 尝试不同的路径策略
    const possiblePaths = [
        // 1. 假设我们在 dist 目录中运行
        path.resolve(__dirname, variant, 'core.js'),
        // 2. 假设我们在 src 目录中运行
        path.resolve(__dirname, '../dist', variant, 'core.js'),
    ]

    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            corePath = p
            break
        }
    }

    if (!corePath) {
        // 开发环境下忽略警告，可能是因为还没构建
        return
    }

    try {
        let content = fs.readFileSync(corePath, 'utf-8')

        // 替换 AllowedOrigins
        const replaceContent = JSON.stringify(allowedOrigins)
        content = content.replace(/"__AllowedOrigins__"/g, replaceContent)
        content = content.replace(/'__AllowedOrigins__'/g, replaceContent)

        // 写入输出目录
        const absoluteOutDir = path.resolve(process.cwd(), outDir)
        if (!fs.existsSync(absoluteOutDir)) {
            fs.mkdirSync(absoluteOutDir, { recursive: true })
        }

        const destPath = path.join(absoluteOutDir, 'core.js')
        fs.writeFileSync(destPath, content, 'utf-8')
    } catch (err) {
        console.error(`[iframe-bridge] Failed to copy core file:`, err)
    }
}

export default function vitePluginIframeBridge(options: IframeBridgeOptions = {}): Plugin {
    const bridgeRegistry: Map<string, BridgeInfo> = new Map()

    return {
        name: 'vite-plugin-iframe-bridge',

        // 开发服务器启动时配置
        configureServer(server: ViteDevServer) {
            // 监听文件变化
            server.watcher.on('change', (filePath) => {
                // 只处理 .ts, .tsx, .vue 文件
                if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx') && !filePath.endsWith('.vue')) {
                    return
                }

                try {
                    const code = fs.readFileSync(filePath, 'utf-8')
                    const bridges = processFile(filePath, code, options)

                    // 更新注册表
                    for (const bridge of bridges) {
                        bridgeRegistry.set(bridge.name, bridge)
                    }
                } catch (err) {
                    console.error(`[iframe-bridge] Error processing ${filePath}:`, err)
                }
            })

            // 首次启动时扫描所有相关文件
            const scanDirectory = (dir: string) => {
                const entries = fs.readdirSync(dir, { withFileTypes: true })
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name)
                    if (entry.isDirectory()) {
                        // 跳过 node_modules 和隐藏目录
                        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
                            scanDirectory(fullPath)
                        }
                    } else if (entry.isFile()) {
                        if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.vue')) {
                            try {
                                const code = fs.readFileSync(fullPath, 'utf-8')
                                const bridges = processFile(fullPath, code, options)
                                for (const bridge of bridges) {
                                    bridgeRegistry.set(bridge.name, bridge)
                                }
                            } catch (err) {
                                // 忽略读取错误
                            }
                        }
                    }
                }
            }

            // 在服务器启动后扫描 src 目录
            const srcDir = path.resolve(process.cwd(), 'src')
            if (fs.existsSync(srcDir)) {
                console.log('[iframe-bridge] Scanning for bridge definitions...')
                scanDirectory(srcDir)
                console.log(`[iframe-bridge] Found ${bridgeRegistry.size} bridge(s)`)
            }
        },

        buildStart() {
            bridgeRegistry.clear()
        },

        transform(code, id) {
            // 在 transform 阶段也处理，确保构建时也能工作
            const bridges = processFile(id, code, options)
            for (const bridge of bridges) {
                bridgeRegistry.set(bridge.name, bridge)
            }
            return null
        }
    }
}
