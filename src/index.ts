// 连接iframe
import { WindowMessenger, connect } from "penpal";

type BridgeEventArgs<T> = [T] extends [void] ? [data?: T] : [data: T]
type BridgeMethods = Record<string, (...args: any[]) => any>

/** 在父窗口定义 bridge，暴露方法给 iframe 调用 */
export const defineBridge = <TEmit extends object = Record<string, unknown>>(
    name: string,
    methods: BridgeMethods
) => {

    return {
        async create(iframe: HTMLIFrameElement, allowedOrigins: string[] = ['*']) {
            if (!iframe.contentWindow) {
                throw new Error('iframe contentWindow is null');
            }
            const conn = connect<{
                onMessage: (type: any, data: any) => void
            }>({
                messenger: new WindowMessenger({
                    remoteWindow: iframe.contentWindow,
                    allowedOrigins,
                }),
                channel: 'iframe-bridge-channel',
                methods
            });
            const remote = await conn.promise;

            return {
                emit<T extends keyof TEmit>(type: T, ...args: BridgeEventArgs<TEmit[T]>) {
                    const [data] = args
                    remote.onMessage(type, data)
                }
            }
        }
    }
}

/** 在 iframe 中定义 bridge，暴露方法给父窗口调用 */
export const defineIframeBridge = <TEmit extends object = Record<string, unknown>>(
    name: string,
    methods: BridgeMethods
) => {

    return {
        async connect(allowedOrigins: string[] = ['*']) {
            const conn = connect<{
                onMessage: (type: any, data: any) => void
            }>({
                messenger: new WindowMessenger({
                    remoteWindow: window.parent,
                    allowedOrigins,
                }),
                channel: 'iframe-bridge-channel',
                methods
            });
            const remote = await conn.promise;

            return {
                emit<T extends keyof TEmit>(type: T, ...args: BridgeEventArgs<TEmit[T]>) {
                    const [data] = args
                    remote.onMessage(type, data)
                },
                destroy: conn.destroy
            }
        }
    }
}
