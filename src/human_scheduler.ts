/**
 * Human AI Main Thread Scheduler
 * Manages frame capture and Worker communication.
 */

export class HumanScheduler {
    private worker: Worker;
    private videoElement: HTMLVideoElement;
    private isBusy = false;
    private onResult: (result: any) => void;

    constructor(videoElement: HTMLVideoElement, onResult: (result: any) => void) {
        this.videoElement = videoElement;
        this.onResult = onResult;

        // 初始化 Worker (使用编译后的 JS 路径)
        this.worker = new Worker("/human.worker.js", {
            type: "module"
        });

        this.setupWorkerListeners();
        this.worker.postMessage({ type: "init" });
    }

    private setupWorkerListeners() {
        this.worker.onmessage = (event) => {
            const { type, payload } = event.data;

            if (type === "ready") {
                console.log("✅ Human AI Worker Ready");
                this.startDetectionLoop();
            }

            if (type === "result") {
                this.onResult(payload);
                this.isBusy = false; // 标记 Worker 空闲，可以接收下一帧
            }
        };
    }

    private startDetectionLoop() {
        const processFrame = async (now: number, metadata: VideoFrameCallbackMetadata) => {
            if (this.isBusy || this.videoElement.paused || this.videoElement.readyState < 2) {
                // 如果 Worker 正在忙或视频不可用，跳过该帧并请求下一帧
                this.videoElement.requestVideoFrameCallback(processFrame);
                return;
            }

            this.isBusy = true;

            try {
                // 使用 createImageBitmap 抓取当前帧，这是一个高效的 Transferable 对象
                const imageBitmap = await createImageBitmap(this.videoElement);

                // 发送给 Worker，并声明 imageBitmap 为转移对象 (Zero-copy)
                this.worker.postMessage(
                    {
                        type: "detect",
                        payload: {
                            imageBitmap,
                            timestamp: metadata.presentationTime
                        }
                    },
                    [imageBitmap] // 转移所有权
                );
            } catch (error) {
                console.error("Frame capture failed:", error);
                this.isBusy = false;
            }

            // 继续请求下一帧回调
            this.videoElement.requestVideoFrameCallback(processFrame);
        };

        // 启动循环
        if ('requestVideoFrameCallback' in this.videoElement) {
            this.videoElement.requestVideoFrameCallback(processFrame);
        } else {
            // 兼容性 Fallback
            const fallback = () => {
                processFrame(performance.now(), {} as any);
                requestAnimationFrame(fallback);
            };
            requestAnimationFrame(fallback);
        }
    }

    public stop() {
        this.worker.terminate();
        this.videoElement.pause();
    }
}
