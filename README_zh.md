# **iframe-bridge-kit**

[English](./README.md) | [简体中文](https://github.com/mchao123/iframe-bridge-kit/blob/master/README_zh.md)

一个轻量级、**强类型**的 Host-to-Iframe（宿主到 Iframe）通信桥接库。基于 [penpal](https://www.google.com/search?q=https://github.com/aaronpowell/penpal) 构建，专为现代 TypeScript 和 Vite 项目设计。

它提供了类型安全的 RPC（远程过程调用）机制和事件发射系统，让跨窗口通信就像调用本地异步函数一样简单。

## **特性**

  * 🔒 **类型安全的 RPC**: 在 Host 端定义 API，在 Iframe 端调用时享受完整的 TypeScript 自动补全。
  * 📨 **事件发射**: 轻松地从 Host 发送类型化的事件到 Iframe。
  * 🚀 **基于 Proxy 的 API**: 通过 Proxy 对象直接调用远程方法，无需繁琐的字符串匹配。
  * 📦 **零配置客户端**: 核心客户端逻辑自动处理连接建立。

## **安装**

```bash
npm install iframe-bridge-kit penpal
# 或者
pnpm add iframe-bridge-kit penpal
```

**注意**: `penpal` 是对等依赖（peer dependency），必须与本包同时安装。

## **使用方法**

### **1. Host 端 (父窗口)**

定义你想暴露给 Iframe 的方法，并指定你可能发送给它的事件。

```typescript
// host.ts
import { defineBridge } from 'iframe-bridge-kit';

// 1. 定义 Host 发送给 Iframe 的事件类型
type HostEvents = {
  'theme-change': 'dark' | 'light';
  'user-update': { id: number; name: string };
};

// 2. 定义 Iframe 可以调用的方法
const bridgeMethods = {
  add: (a: number, b: number) => a + b,
  greet: (name: string) => `Hello, ${name}!`
};

// 3. 创建桥接定义
// 泛型参数 <HostEvents> 确保了 emit 时的类型安全
export const myBridge = defineBridge<HostEvents>('my-bridge-scope', bridgeMethods);

// 4. 挂载到 iframe (当 DOM 中的 iframe 元素准备好时)
const iframe = document.querySelector('iframe');

// create 返回一个实例来控制这个特定的 iframe 连接
// 第二个参数是出于安全考虑的允许源（allowed origins）列表
const bridgeInstance = await myBridge.create(iframe, ['http://localhost:3000']);

// 现在你可以向 iframe 发送事件了
bridgeInstance.emit('theme-change', 'dark');
```

### **2. Client 端 (Iframe)**

在你的 Iframe 项目中，导入核心模块以访问 Host 方法并监听事件。

**重要**: 你必须在 Iframe 项目中使用配套的 Vite 插件（见第 3 节），因为它负责注入安全令牌。

```typescript
// iframe.ts
import api, { onMessage, isInit, onInit } from 'iframe-bridge-kit/core';

// 1. 调用 Host 方法
// `api` 是一个 Proxy 对象。所有方法调用都会返回一个 Promise。
const initIframe = async () => {
  // 可选: 如果需要立即使用，可以等待连接建立
  if (!isInit()) {
    await new Promise(resolve => onInit(resolve));
  }

  // 调用在 Host 中定义的方法
  const sum = await api.add(10, 20);
  console.log(sum); // 30

  const greeting = await api.greet('ZhangSan');
  console.log(greeting);
};

// 2. 监听 Host 事件
const cleanup = onMessage('theme-change', (theme) => {
  console.log('主题变更为:', theme);
});

initIframe();
```

### **3. Vite 配置 (Iframe 端必须)**

本库依赖一个 Vite 插件将 `allowedOrigins` 注入到客户端代码中。

请在 **Iframe 项目**的 `vite.config.ts` 中进行配置：

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { iframeBridge } from 'iframe-bridge-kit/vite';

export default defineConfig({
  plugins: [
    iframeBridge({
      // Host (父) 应用的 URL
      allowedOrigins: ['http://localhost:8080'],

      // 可选: 桥接资源的输出目录
      outDir: 'dist',
    })
  ]
});
```

## **API 参考**

### **Host API**

#### **defineBridge\<TEmit\>(name, methods)**

创建一个桥接定义。

  * **TEmit**: 描述从 Host 发送到 Iframe 的事件的 TypeScript 接口。
  * **name**: 桥接的唯一命名空间。
  * **methods**: 暴露给 Iframe 的包含函数的对象。

#### **bridgeDef.create(iframe, allowedOrigins)**

连接到一个指定的 iframe 元素。

  * **iframe**: HTMLIFrameElement。
  * **allowedOrigins**: 字符串数组（例如 `['http://localhost:3000']`），用于安全验证。
  * **Returns**: 解析为 `BridgeInstance` 的 Promise。

#### **BridgeInstance.emit(type, data)**

向已连接的 Iframe 发送类型化消息。

### **Client API (iframe-bridge-kit/core)**

#### **api (默认导出)**

一个 Proxy 对象。在此对象上调用的任何方法都会通过 penpal 发送到 Host。返回一个 Promise。

#### **onMessage(type, callback, once?)**

注册一个监听器，用于接收来自 Host 的事件。

  * 返回一个清理（cleanup）函数。

#### **isInit()**

返回布尔值。检查与父级的连接是否已建立。

#### **onInit(callback)**

注册一个回调函数，当连接建立时执行。

## **许可**

MIT © [ZhangSan](https://github.com/mchao123)