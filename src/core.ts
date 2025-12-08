
import { WindowMessenger, connect } from 'penpal';


const msgProxy = new Map<string, Set<Function>>()
const conn = connect({
    messenger: new WindowMessenger({
        remoteWindow: window.parent,
        allowedOrigins: ['__AllowedOrigins__'],
    }),
    channel: 'iframe-bridge-channel',
    methods: {
        onMessage(type: string, data: any) {
            const fns = msgProxy.get(type)
            if (fns) {
                fns.forEach(cb => cb(data))
                return true
            }
        }
    },
});

export default new Proxy({}, {
    get(_, prop) {
        return async (args: any) => {
            // @ts-ignore
            return await conn.promise.then(e => e[prop](args))
        }
    }
})


export const onMessage = (type: string, cb: Function, once?: boolean) => {
    const fn = once ? ((data: any) => {
        cb(data)
        offMessage(type, cb)
    }) : cb
    const fns = msgProxy.get(type)

    if (fns) {
        fns.add(fn)
    } else {
        msgProxy.set(type, new Set([fn]))
    }
    return () => offMessage(type, fn)
}

export const offMessage = (type: string, fn?: Function) => {
    if (!fn) {
        msgProxy.delete(type)
        return
    }
    const fns = msgProxy.get(type)
    if (fns) {

        fns.delete(fn)
    }
}

let isInited = false
conn.promise.then(() => {
    isInited = true
})

// 是否初始化
export const isInit = () => isInited

export const onInit = (cb: Function) => {
    if (isInited) {
        cb()
        return
    }
    conn.promise.then(() => {
        cb()
    })
}