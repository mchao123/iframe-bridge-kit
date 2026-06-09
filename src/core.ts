
import { WindowMessenger, connect } from 'penpal';
import { callbackInvokeMethod, createCallbackBridge } from './callbacks.js';


type RemoteApi = Record<string, (...args: any[]) => Promise<any>>
type RemoteMethods = Record<string, (...args: any[]) => any>
type RemoteEndpoint = RemoteApi & Record<typeof callbackInvokeMethod, (id: string, args: any[]) => Promise<any>>
type BridgeControls = {
    onMessage: (type: string, cb: Function, once?: boolean) => () => void
    offMessage: (type: string, fn?: Function) => void
    isInit: () => boolean
    onInit: (cb: Function) => void
    destroy: () => void
}

const channel = 'iframe-bridge-channel'
const defaultAllowedOrigins = ['__AllowedOrigins__']

class BridgeClient {
    private msgProxy = new Map<string, Set<Function>>()
    private initCallbacks = new Set<Function>()
    private conn: ReturnType<typeof connect<RemoteMethods>> | undefined
    private remotePromise: Promise<RemoteEndpoint> | undefined
    private inited = false
    private connectionId = 0
    private callbacks = createCallbackBridge(() => this.getRemote())
    readonly api: RemoteApi & BridgeControls

    constructor() {
        const controls: BridgeControls = {
            onMessage: this.onMessage,
            offMessage: this.offMessage,
            isInit: this.isInit,
            onInit: this.onInit,
            destroy: this.destroy,
        }

        this.api = new Proxy({} as RemoteApi & BridgeControls, {
            get: (_, prop) => {
                if (prop === 'then') {
                    return undefined
                }
                if (typeof prop !== 'string') {
                    return undefined
                }
                if (prop in controls) {
                    return controls[prop as keyof BridgeControls]
                }
                return async (...args: any[]) => {
                    const remote = await this.getRemote()
                    const method = remote[prop]
                    if (typeof method !== 'function') {
                        throw new Error(`Remote method \"${String(prop)}\" is not available`)
                    }
                    return this.callbacks.deserialize(await method(...this.callbacks.serialize(args)))
                }
            }
        })
    }

    connect = (remoteWindow: Window, allowedOrigins: string[] = defaultAllowedOrigins) => {
        this.conn?.destroy()
        this.inited = false
        const currentId = ++this.connectionId
        this.conn = connect<RemoteMethods>({
            messenger: new WindowMessenger({
                remoteWindow,
                allowedOrigins,
            }),
            channel,
            methods: {
                onMessage: this.receiveMessage,
                [callbackInvokeMethod]: this.callbacks.invokeLocalCallback,
            },
        })
        this.remotePromise = this.conn.promise.then(remote => {
            if (currentId === this.connectionId) {
                this.inited = true
                this.notifyInit()
            }
            return remote as RemoteEndpoint
        })
        return this.remotePromise
    }

    private getRemote = () => {
        if (!this.remotePromise) {
            if (typeof window === 'undefined' || window.parent === window) {
                throw new Error('remoteWindow is not configured. Pass a Window when creating the bridge client.')
            }
            return this.connect(window.parent)
        }
        return this.remotePromise
    }

    private receiveMessage = (type: string, data: any) => {
        const fns = this.msgProxy.get(type)
        if (fns) {
            const value = this.callbacks.deserialize(data)
            fns.forEach(cb => cb(value))
            return true
        }
    }

    private notifyInit = () => {
        const callbacks = Array.from(this.initCallbacks)
        this.initCallbacks.clear()
        callbacks.forEach(cb => cb(this.api))
    }

    onMessage = (type: string, cb: Function, once?: boolean) => {
        const fn = once ? ((data: any) => {
            cb(data)
            this.offMessage(type, fn)
        }) : cb
        const fns = this.msgProxy.get(type)

        if (fns) {
            fns.add(fn)
        } else {
            this.msgProxy.set(type, new Set([fn]))
        }
        return () => this.offMessage(type, fn)
    }

    offMessage = (type: string, fn?: Function) => {
        if (!fn) {
            this.msgProxy.delete(type)
            return
        }
        const fns = this.msgProxy.get(type)
        if (fns) {
            fns.delete(fn)
        }
    }

    isInit = () => this.inited

    onInit = (cb: Function) => {
        if (this.inited) {
            cb(this.api)
            return
        }
        this.initCallbacks.add(cb)
    }

    destroy = () => {
        this.connectionId++
        this.conn?.destroy()
        this.conn = undefined
        this.remotePromise = undefined
        this.inited = false
        this.initCallbacks.clear()
        this.callbacks.clearCallbacks()
    }
}

export const createBridgeClient = (remoteWindow: Window, allowedOrigins: string[] = defaultAllowedOrigins) => {
    const client = new BridgeClient()
    client.connect(remoteWindow, allowedOrigins)
    return client.api
}


let lastClient: ReturnType<typeof createBridgeClient> | undefined
export default () => {
    if (!lastClient) {
        lastClient = createBridgeClient(window.parent)
    }
    return lastClient
}
