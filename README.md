# **iframe-bridge-kit**

[English](./README.md) | [简体中文](https://github.com/mchao123/iframe-bridge-kit/README_zh-CN.md)

A lightweight, **strongly-typed** bridge for Host-to-Iframe communication. Built on top of [penpal](https://www.google.com/search?q=https://github.com/aaronpowell/penpal), designed for modern TypeScript and Vite projects.

It provides a type-safe RPC (Remote Procedure Call) mechanism and event emission system, making cross-window communication as easy as calling local async functions.

## **Features**

* 🔒 **Type-Safe RPC**: Define APIs on the Host, call them from the Iframe with full TypeScript autocompletion.  
* 📨 **Event Emission**: Send typed events from Host to Iframe easily. 
* 🚀 **Proxy-based API**: Call remote methods directly via a Proxy object without messy string matching.  
* 📦 **Zero-config Client**: The core client logic handles connection establishment automatically.

## **Installation**

npm install iframe-bridge-kit penpal  
# or  
pnpm add iframe-bridge-kit penpal

**Note**: penpal is a peer dependency and must be installed alongside this package.

## **Usage**

### **1. Host Side (Parent Window)**

Define the methods you want to expose to the Iframe, and specify the events you might emit to it.
```typescript
// host.ts  
import { defineBridge } from 'iframe-bridge-kit';

// 1. Define Event types that Host sends to Iframe  
type HostEvents = {  
  'theme-change': 'dark' | 'light';  
  'user-update': { id: number; name: string };  
};

// 2. Define methods that Iframe can call  
const bridgeMethods = {  
  add: (a: number, b: number) => a + b,  
  greet: (name: string) => `Hello, ${name}!`  
};

// 3. Create the bridge definition  
export const myBridge = defineBridge<HostEvents>('my-bridge-scope', bridgeMethods);

// 4. Mount to iframe (when iframe element is ready in DOM)  
const iframe = document.querySelector('iframe');

// create returns an instance to control this specific iframe connection  
// The second argument is the list of allowed origins for security  
const bridgeInstance = await myBridge.create(iframe, ['http://localhost:3000']);

// Now you can emit events to the iframe  
bridgeInstance.emit('theme-change', 'dark');
```

### **2. Client Side (Iframe)**

In your Iframe project, import the core module to access Host methods and listen for events.

**Important**: You must use the accompanying Vite plugin in your Iframe project (see section 3) because it handles the security token injection.

```typescript
// iframe.ts  
import api, { onMessage, isInit, onInit } from 'iframe-bridge-kit/core';

// 1. Call Host Methods  
// `api` is a Proxy. All method calls return a Promise.  
const initIframe = async () => {  
  // Optional: Wait for connection if needed immediately  
  if (!isInit()) {  
    await new Promise(resolve => onInit(resolve));  
  }

  // Call methods defined in Host  
  const sum = await api.add(10, 20);   
  console.log(sum); // 30  
    
  const greeting = await api.greet('ZhangSan');  
  console.log(greeting);  
};

// 2. Listen for Host Events  
const cleanup = onMessage('theme-change', (theme) => {  
  console.log('Theme changed to:', theme);  
});

initIframe();
```

### **3. Vite Configuration (Required for Iframe)**

This library relies on a Vite plugin to inject the allowedOrigins into the client code.

Configure this in your **Iframe project's** vite.config.ts:
```typescript
// vite.config.ts  
import { defineConfig } from 'vite';  
import { iframeBridge } from 'iframe-bridge-kit/vite';

export default defineConfig({  
  plugins: [  
    iframeBridge({  
      // The URL of the Host (Parent) application  
      allowedOrigins: ['http://localhost:8080'],   
        
      // Optional: Output directory for bridge assets  
      outDir: 'dist',  
    })  
  ]  
});
```

## **API Reference**

### **Host API**

#### **defineBridge<TEmit>(name, methods)**

Creates a bridge definition.

* **TEmit**: TypeScript interface describing the events sent from Host to Iframe.  
* **name**: Unique namespace for the bridge.  
* **methods**: Object containing functions exposed to the Iframe.

#### **bridgeDef.create(iframe, allowedOrigins)**

Connects to a specific iframe element.

* **iframe**: HTMLIFrameElement.  
* **allowedOrigins**: Array of strings (e.g., ['http://localhost:3000']) for security.  
* **Returns**: Promise resolving to a BridgeInstance.

#### **BridgeInstance.emit(type, data)**

Sends a typed message to the connected Iframe.

### **Client API (iframe-bridge-kit/core)**

#### **api (Default Export)**

A Proxy object. Any method called on this object is sent via penpal to the Host. Returns a Promise.

#### **onMessage(type, callback, once?)**

Register a listener for events sent from the Host.

* Returns a cleanup function.

#### **isInit()**

Returns boolean. Checks if the connection to the parent is established.

#### **onInit(callback)**

Register a callback to run when the connection is established.

## **License**

MIT © [ZhangSan](https://github.com/mchao123)