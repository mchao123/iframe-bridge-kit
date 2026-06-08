import { WindowMessenger, connect } from 'penpal';

const createMessageHub = () => {
    const msgProxy = new Map<string, Set<Function>>()

    const onMessage = (type: string, cb: Function, once?: boolean) => {
        const fn = once ? ((data: any) => {
            cb(data)
            offMessage(type, fn)
        }) : cb
        const fns = msgProxy.get(type)

        if (fns) {
            fns.add(fn)
        } else {
            msgProxy.set(type, new Set([fn]))
        }
        return () => offMessage(type, fn)
    }

    const offMessage = (type: string, fn?: Function) => {
        if (!fn) {
            msgProxy.delete(type)
            return
        }
        const fns = msgProxy.get(type)
        if (fns) {
            fns.delete(fn)
        }
    }

    const emitMessage = (type: string, data: any) => {
        const fns = msgProxy.get(type)
        if (fns) {
            fns.forEach(cb => cb(data))
            return true
        }
    }

    return { onMessage, offMessage, emitMessage }
}

export const create = (iframe: HTMLIFrameElement, allowedOrigins: string[] = ['__AllowedOrigins__']) => {
    if (!iframe.contentWindow) {
        throw new Error('iframe contentWindow is null');
    }

    const { onMessage, offMessage, emitMessage } = createMessageHub()
    const conn = connect({
        messenger: new WindowMessenger({
            remoteWindow: iframe.contentWindow,
            allowedOrigins,
        }),
        channel: 'iframe-bridge-channel',
        methods: {
            onMessage(type: string, data: any) {
                return emitMessage(type, data)
            }
        },
    });

    let isInited = false
    conn.promise.then(() => {
        isInited = true
    })

    const api = new Proxy({}, {
        get(_, prop) {
            return async (...args: any[]) => {
                // @ts-ignore
                return await conn.promise.then(e => e[prop](...args))
            }
        }
    })

    return {
        api,
        onMessage,
        offMessage,
        isInit: () => isInited,
        onInit(cb: Function) {
            if (isInited) {
                cb()
                return
            }
            conn.promise.then(() => {
                cb()
            })
        },
        destroy: conn.destroy
    }
}

export default { create }