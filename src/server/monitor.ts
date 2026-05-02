import { faceEngine } from '@modules/face_engine';
import { CameraStream } from "./tools/Camera/camera";

import Pipe2Jpeg from 'pipe2jpeg';

async function monitor() {
    const camera = new CameraStream();
    const p2j = new Pipe2Jpeg();

    // 加载 AI 模型
    await faceEngine.loadModels();

    // 1. 建立管道：Camera -> 拆分器
    camera.pipe(p2j);

    // 2. 监听拆分出的每一帧 JPEG
    p2j.on('jpeg', async (jpegBuffer: Buffer) => {
        // 3. 交给 FaceEngine 处理，不关心数据来源
        const results = await faceEngine.recognizeFaces(jpegBuffer);

        if (results.length > 0) {
            console.log('检测结果:', results);
        }
    });

    camera.start();
}

monitor();
