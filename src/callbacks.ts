const callbackRefType = 'iframe-bridge-kit.callback'

export const callbackInvokeMethod = '__iframeBridgeInvokeCallback'

type CallbackDescriptor = {
    __iframeBridgeType: typeof callbackRefType
    id: string
}

type RemoteCallbacks = Record<typeof callbackInvokeMethod, (id: string, args: any[]) => Promise<any>>

const isObject = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null

const isPlainObject = (value: object) => {
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

const isCallbackDescriptor = (value: unknown): value is CallbackDescriptor => {
    return isObject(value) && value.__iframeBridgeType === callbackRefType && typeof value.id === 'string'
}

export const createCallbackBridge = (getRemote: () => Promise<RemoteCallbacks> | RemoteCallbacks) => {
    const localCallbacks = new Map<string, Function>()
    const localCallbackIds = new WeakMap<Function, string>()
    const remoteCallbacks = new Map<string, Function>()
    let nextCallbackId = 0

    const registerLocalCallback = (fn: Function): CallbackDescriptor => {
        let id = localCallbackIds.get(fn)
        if (!id) {
            id = `${Date.now().toString(36)}-${(++nextCallbackId).toString(36)}`
            localCallbackIds.set(fn, id)
        }
        localCallbacks.set(id, fn)
        return {
            __iframeBridgeType: callbackRefType,
            id,
        }
    }

    const serialize = (value: any, seen = new WeakMap<object, any>()): any => {
        if (typeof value === 'function') {
            return registerLocalCallback(value)
        }

        if (!isObject(value)) {
            return value
        }

        if (seen.has(value)) {
            return seen.get(value)
        }

        if (Array.isArray(value)) {
            const copy: any[] = []
            seen.set(value, copy)
            value.forEach((item, index) => {
                copy[index] = serialize(item, seen)
            })
            return copy
        }

        if (!isPlainObject(value)) {
            return value
        }

        const copy: Record<string, any> = {}
        seen.set(value, copy)
        Object.keys(value).forEach(key => {
            copy[key] = serialize(value[key], seen)
        })
        return copy
    }

    const deserialize = (value: any, seen = new WeakMap<object, any>()): any => {
        if (!isObject(value)) {
            return value
        }

        if (isCallbackDescriptor(value)) {
            let callback = remoteCallbacks.get(value.id)
            if (!callback) {
                callback = async (...args: any[]) => {
                    const remote = await getRemote()
                    const result = await remote[callbackInvokeMethod](value.id, serialize(args))
                    return deserialize(result)
                }
                remoteCallbacks.set(value.id, callback)
            }
            return callback
        }

        if (seen.has(value)) {
            return seen.get(value)
        }

        if (Array.isArray(value)) {
            const copy: any[] = []
            seen.set(value, copy)
            value.forEach((item, index) => {
                copy[index] = deserialize(item, seen)
            })
            return copy
        }

        if (!isPlainObject(value)) {
            return value
        }

        const copy: Record<string, any> = {}
        seen.set(value, copy)
        Object.keys(value).forEach(key => {
            copy[key] = deserialize(value[key], seen)
        })
        return copy
    }

    const invokeLocalCallback = async (id: string, args: any[]) => {
        const callback = localCallbacks.get(id)
        if (!callback) {
            throw new Error(`Callback "${id}" is not available`)
        }
        const result = await callback(...deserialize(args))
        return serialize(result)
    }

    const clearCallbacks = () => {
        localCallbacks.clear()
        remoteCallbacks.clear()
    }

    return {
        serialize,
        deserialize,
        invokeLocalCallback,
        clearCallbacks,
    }
}