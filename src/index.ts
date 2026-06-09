// 连接iframe
import { WindowMessenger, connect } from "penpal";
import { callbackInvokeMethod, createCallbackBridge } from "./callbacks.js";

type BridgeTarget = HTMLIFrameElement | Window
type RemoteBridge = {
    onMessage: <T extends string>(type: T, data: any) => void
    [callbackInvokeMethod]: (id: string, args: any[]) => Promise<any>
}

const resolveRemoteWindow = (target: BridgeTarget): Window => {
    if (typeof HTMLIFrameElement !== 'undefined' && target instanceof HTMLIFrameElement) {
        if (!target.contentWindow) {
            throw new Error('remoteWindow is null');
        }
        return target.contentWindow;
    }

    return target as Window;
}

/** 定义一个 bridge，暴露方法给 iframe 父/子窗口调用 */
export const defineBridge = <TEmit extends Record<string, object | string | number | boolean | null | undefined>>(
    name: string,
    methods: BridgeMethods
) => {

    return async (target: BridgeTarget, allowedOrigins: string[] = ['*']) => {
        const remoteWindow = resolveRemoteWindow(target);
        let remotePromise: Promise<RemoteBridge>
        const callbacks = createCallbackBridge(() => remotePromise)
        const bridgeMethods = Object.keys(methods).reduce<Record<string, (...args: any[]) => any>>((wrapped, methodName) => {
            if (methodName === callbackInvokeMethod) {
                throw new Error(`Method name "${callbackInvokeMethod}" is reserved by iframe-bridge-kit`)
            }
            wrapped[methodName] = async (...args: any[]) => {
                const result = await methods[methodName].apply(methods, callbacks.deserialize(args))
                return callbacks.serialize(result)
            }
            return wrapped
        }, {
            [callbackInvokeMethod]: callbacks.invokeLocalCallback,
        })
        const conn = connect<RemoteBridge>({
            messenger: new WindowMessenger({
                remoteWindow,
                allowedOrigins,
            }),
            channel: 'iframe-bridge-channel',
            methods: bridgeMethods,
        });
        remotePromise = conn.promise as Promise<RemoteBridge>;
        const remote = await remotePromise;

        return {
            emit<T extends keyof TEmit>(type: T, data: TEmit[T]) {
                return remote.onMessage(type as string, callbacks.serialize(data))
            },
            destroy() {
                callbacks.clearCallbacks()
                conn.destroy()
            },
        }
    }
}
