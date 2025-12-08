// 连接iframe
import { WindowMessenger, connect } from "penpal";


/** 定义一个 bridge，暴露方法给 iframe 父/子窗口调用 */
export const defineBridge = <TEmit extends Record<string, object | string | number | boolean | null | undefined>>(
    name: string,
    methods: Record<string, (...args: any[]) => any>
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
                emit<T extends keyof TEmit>(type: T, data: TEmit[T]) {
                    remote.onMessage(type, data)
                }
            }
        }
    }
}
