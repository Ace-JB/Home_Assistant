import { Human, type Config } from "@vladmandic/human";

let human: Human | null = null;

const humanConfig: Partial<Config> = {
    backend: "webgl",
    modelBasePath: "/models/", // 使用本地静态路由，支持完全断网运行
    filter: { enabled: true, equalization: false },
    face: {
        enabled: true,
        detector: { return: true, rotation: true, mask: false },
        mesh: { enabled: true },
        iris: { enabled: true },
        description: { enabled: true },
        emotion: { enabled: true },
    },
    body: { enabled: true }, // 开启身体检测以支持更多全身动作
    hand: {
        enabled: true,
    },
    gesture: { enabled: true },
    softwareKernels: false,
};

/**
 * Worker 初始化
 */
onmessage = async (event) => {
    const { type, payload } = event.data;

    if (type === "init") {
        human = new Human(humanConfig);
        console.log("🤖 Human AI Worker: Initializing...");
        await human.load();
        await human.warmup();
        postMessage({ type: "ready" });
    }

    if (type === "detect" && human) {
        const { imageBitmap, timestamp } = payload;

        // 执行 AI 检测
        const result = await human.detect(imageBitmap);

        // 提取核心数据回传给主线程
        // 注意：这里只传回必要的数据，避免克隆开销
        postMessage({
            type: "result",
            payload: {
                face: result.face,
                gesture: result.gesture,
                hand: result.hand,
                timestamp,
            }
        });

        // 重要：释放 ImageBitmap 资源，防止内存泄漏
        imageBitmap.close();
    }
};
