# iframe-bridge-kit

[English](./README.md) | [简体中文](https://github.com/mchao123/iframe-bridge-kit/blob/master/README_zh.md)

`iframe-bridge-kit` 是一个基于 [Vite](https://vitejs.dev/) 和 [Penpal](https://www.google.com/search?q=https://github.com/google/penpal) 的 iframe 通信库。它通过 Vite 插件自动生成类型定义，让父窗口和 iframe 子窗口可以互相暴露 RPC 方法，并享受到 **100% 的 TypeScript 类型提示**，就像调用本地函数一样简单。

## ✨ 特性

  * 🔒 **类型安全**: 基于源码自动生成 `.d.ts`，父子窗口共享完全一致的类型。
  * 🚀 **零重复类型定义**: 另一侧窗口无需手动同步接口，直接导入生成的桥接文件即可使用。
  * 📡 **RPC 风格**: 像调用 `async` 函数一样调用跨窗口方法。
  * ⚡ **事件机制**: 支持父窗口和 iframe 子窗口发送强类型的广播消息。
  * 🛠 **Vite 集成**: 专为 Vite 生态设计，支持热更新。

## 📦 安装

你需要同时安装 `iframe-bridge-kit` 和它的对等依赖 `penpal`。

```bash
npm install iframe-bridge-kit penpal
# 或者
pnpm add iframe-bridge-kit penpal
# 或者
yarn add iframe-bridge-kit penpal
```

## ⚙️ 配置

在你的 `vite.config.ts` 中引入插件。

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue' // 或其他框架插件
import vitePluginIframeBridge from 'iframe-bridge-kit/vite'

export default defineConfig({
  plugins: [
    vue(),
    vitePluginIframeBridge({
      // 输出目录，默认为 'src/bridges' (建议放入 src 下以便导入)
      outDir: 'src/bridges', 
      // 是否生成完整版代码 (包含 Penpal 依赖)，默认为 true
      full: true 
    })
  ]
})
```

## 📖 使用指南

### 1\. 父窗口定义 API，iframe 调用父窗口

在父窗口中，使用 `defineBridge` 定义暴露给 iframe 的方法和事件类型。

```typescript
// src/views/Parent.vue (或其他 .ts 文件)
import { defineBridge } from 'iframe-bridge-kit'
import { ref, onMounted } from 'vue'

// 定义 Parent 发送给 Child 的事件类型
interface EmitMap {
  'theme-change': { mode: 'dark' | 'light' }
  'user-logout': void
}

// 1. 定义 Bridge
// 第一个参数 'app-bridge' 是桥接名称，将用于生成文件夹名
export const mainBridge = defineBridge<EmitMap>('app-bridge', {
  // 暴露给 iframe 的方法
  async getUserInfo(id: string) {
    return { id, name: 'John Doe', role: 'admin' }
  },
  
  updateTitle(title: string) {
    document.title = title
    return true
  }
})

// 2. 绑定 iframe
const iframeRef = ref<HTMLIFrameElement>()

onMounted(async () => {
  if (iframeRef.value) {
    const child = await mainBridge.create(iframeRef.value)
    
    // 向 iframe 发送消息
    child.emit('theme-change', { mode: 'dark' })
  }
})
```

> **注意**: 保存文件后，Vite 插件会自动扫描 `defineBridge`，并在 `src/bridges/app-bridge/` 下生成对应的类型定义和运行时代码。

### 2\. 子窗口 (Iframe/Child)

在 iframe 项目中，**直接导入插件生成的文件**。所有的 API 方法都拥有严格的类型推断。

```typescript
// src/views/IframeChild.vue
// 从生成的目录导入 (路径取决于你的 outDir 配置)
import ParentApi, { onMessage, onInit } from '../bridges/app-bridge'

// 等待连接初始化完成 (可选)
onInit(() => {
  console.log('Bridge connected!')
})

// 1. 调用父窗口方法 (RPC)
async function fetchUser() {
  // ✅ 这里的 id 和返回值都有完整的类型提示！
  const user = await ParentApi.getUserInfo('123')
  console.log(user.name) 
}

// 2. 监听父窗口消息
// ✅ 'theme-change' 和回调参数 data 都有类型提示
onMessage('theme-change', (data) => {
  console.log('New theme:', data.mode)
})
```

### 3\. iframe 定义 API，父窗口调用 iframe

如果你的主要诉求是先写一个 iframe 页面，再让父窗口兼容这个 iframe，可以在 iframe 项目中使用 `defineIframeBridge`。插件会根据 iframe 暴露的方法生成父窗口可导入的客户端。

```typescript
// src/iframeBridge.ts (iframe 项目内)
import { defineIframeBridge } from 'iframe-bridge-kit'

interface ChildEmitMap {
  'ready': { url: string }
  'height-change': { height: number }
}

export const childBridge = defineIframeBridge<ChildEmitMap>('child-app', {
  async getPageInfo() {
    return {
      title: document.title,
      url: location.href
    }
  },

  setTheme(mode: 'dark' | 'light') {
    document.documentElement.dataset.theme = mode
    return true
  }
})

childBridge.connect().then((parent) => {
  parent.emit('ready', { url: location.href })
})
```

保存后会生成 `src/bridges/child-app/`。父窗口项目可以导入这个目录，并通过 `create(iframe)` 获得 iframe 暴露的强类型方法。

```typescript
// src/views/Parent.vue (父窗口项目内)
import ChildBridge from '../bridges/child-app'

const iframe = document.querySelector<HTMLIFrameElement>('#child-app')!
const child = ChildBridge.create(iframe)

child.onInit(async () => {
  const info = await child.api.getPageInfo()
  console.log(info.title)

  await child.api.setTheme('dark')
})

child.onMessage('height-change', ({ height }) => {
  iframe.style.height = `${height}px`
})
```

## 🧩 类型支持详情

`iframe-bridge-kit` 的核心魔法在于它如何处理类型。

当你定义方法时：

```typescript
getUserInfo(id: string): Promise<User>
```

插件会提取 `User` 接口（甚至包括从 node\_modules 导入的类型），并将其**复制**到生成的 `index.d.ts` 中。这意味着子窗口不需要访问父窗口的源码，也不需要安装父窗口的依赖，就能获得完美的类型提示。

### 支持的类型特性

  * 基本类型 (string, number, boolean)
  * 接口与类型别名 (Interface & Type Alias)
  * 泛型展开
  * 第三方库类型 (自动处理 import 路径)

## 🔌 API 参考

### `defineBridge<TEmit>(name, methods)`

  * **name**: `string` - 桥接名称，决定生成文件的目录名。
  * **methods**: `Object` - 暴露给子窗口的方法集合。
  * **TEmit**: `Generic` - (可选) 定义父窗口通过 `emit` 发送的事件类型映射。

返回一个对象，包含：

  * `create(iframeEl, allowedOrigins?)`: 初始化连接，返回 `{ emit }` 对象。

### `defineIframeBridge<TEmit>(name, methods)`

  * **name**: `string` - 桥接名称，决定生成文件的目录名。
  * **methods**: `Object` - iframe 暴露给父窗口的方法集合。
  * **TEmit**: `Generic` - (可选) 定义 iframe 通过 `emit` 发送给父窗口的事件类型映射。

返回一个对象，包含：

  * `connect(allowedOrigins?)`: 在 iframe 中连接父窗口，返回 `{ emit, destroy }` 对象。

### Vite 插件配置 (`IframeBridgeOptions`)

| 选项 | 类型 | 默认值 | 描述 |
|:---|:---|:---|:---|
| `outDir` | `string` | `'bridges'` | 生成代码的输出目录。建议设为 `'src/bridges'`。 |
| `allowedOrigins` | `string[]` | `['*']` | 允许通信的源域名列表。 |
| `full` | `boolean` | `true` | 是否生成包含完整依赖的代码。 |
| `preserveModules` | `string[]` | `[]` | 保留特定模块的导入而不是展开类型（例如 `['vue']`）。 |

### 生成的 Child API

假设 `outDir` 为 `src/bridges`，桥接名为 `my-bridge`，你可以从 `src/bridges/my-bridge` 导入：

  * **`default` (ParentApi)**: 包含所有父窗口方法的代理对象。所有方法均返回 `Promise`。
  * **`onMessage(type, callback, once?)`**: 监听父窗口发出的事件。
  * **`offMessage(type, callback?)`**: 取消监听。
  * **`onInit(callback)`**: 当连接建立成功时触发。
  * **`isInit()`**: 返回当前连接状态。

### 生成的 Parent API

当桥接来自 `defineIframeBridge` 时，同一个生成目录会导出父窗口客户端：

  * **`create(iframeEl, allowedOrigins?)`**: 初始化与 iframe 的连接，返回 `BridgeConnection`。
  * **`connection.api`**: iframe 暴露给父窗口的强类型方法代理，所有方法均返回 `Promise`。
  * **`connection.onMessage(type, callback, once?)`**: 监听 iframe 发出的事件。
  * **`connection.offMessage(type, callback?)`**: 取消监听。
  * **`connection.onInit(callback)`**: 当连接建立成功时触发。
  * **`connection.isInit()`**: 返回当前连接状态。
  * **`connection.destroy()`**: 断开当前连接。

## ⚠️ 注意事项

1.  **同源策略**: 虽然 Penpal 简化了 postMessage，但请确保正确配置 `allowedOrigins` 以保证安全性。
2.  **构建顺序**: 在生产构建时，确保包含 `defineBridge` 的文件被正确处理。通常只要这些文件在你的源码树中（被 import 引用），Vite 插件就能扫描到。
3.  **JSON 序列化**: 跨窗口传输的数据必须是可 JSON 序列化的（不支持 Function, DOM 节点等）。

## License

MIT