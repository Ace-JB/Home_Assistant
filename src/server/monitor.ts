import { faceEngine } from '@/server/modules/media/face';
import { initCamera } from "./tools/Camera";
import { initAudioListen } from "./tools/Voice";

import Pipe2Jpeg from 'pipe2jpeg';
import { syncManager } from './modules/media';
import { faceValue, triggerUrgencySave, Urgency } from './tools/wiseRelex';

async function monitor() {
    const [{ stream: video }, { stream: audio }] = await Promise.all([
        initCamera(),
        initAudioListen(),
    ]);

    // 1. 使用 Pipe2Jpeg 将视频流切分为完整的 JPEG 帧，防止因为截断半张图片导致 FFmpeg 合成失败
    const p2j = new Pipe2Jpeg();
    // video.on('data', (chunk) => console.log('视频流收到原始数据块大小:', chunk.length));
    video.pipe(p2j);

    p2j.on('data', (jpegBuffer: Buffer) => {
        // console.log('接收到完整视频帧');
        syncManager.addVideo(jpegBuffer);
    });

    audio.on('data', (data: Buffer) => {
        // console.log('接收到音频块');
        syncManager.addAudio(data);
    });

    // 2. 加载 AI 模型(面部识别、动作识别等)
    await faceEngine.loadModels();

    // 3. 如何触发 smartSave 保存视频？通常有两种策略：

    // 策略 A：【事件驱动】当检测到异常时，保存过去 N 秒的视频（这是 SyncManager 的核心设计初衷）

    p2j.on('data', async (jpegBuffer: Buffer) => {

        if (faceValue.canExecute()) {
            const result = await faceEngine.recognizeFaces(jpegBuffer);

            const strangerCount = result.filter(r => r.label === '未知陌生人').length;

            if (strangerCount >= 4) {
                triggerUrgencySave(Urgency.HIGH);
            } else if (strangerCount >= 2) {
                triggerUrgencySave(Urgency.MEDIUM);
            } else {
                triggerUrgencySave(Urgency.LOW);
            }

        }

    });

    // 策略 B：【定时循环保存】每隔固定的时间（例如 30 秒）自动保存上一段记录，实现类似于行车记录仪的功能
    /*
    setInterval(async () => {
        console.log('⏳ 执行常规视频存档...');
        // SyncManager 默认是 30 秒的环形缓冲区，这里我们把过去 30 秒的数据都拿出来保存
        const snapshot = syncManager.getSnapshot(30000);
        await smartSave(snapshot);
    }, 30000);
    */

    // 考虑加入语音模型，用于识别语音命令，和上面一样，不过换成本地的，不需要外网，本地模型离线使用
}

monitor().catch((error) => {
    console.error('Monitor failed to start:', error);
    console.error('Tip: list macOS AVFoundation devices with `ffmpeg -f avfoundation -list_devices true -i ""` and update GLOBAL_CONFIG.VIDEO.DEVICE / GLOBAL_CONFIG.VOICE.DEVICE.');
    process.exit(1);
});
