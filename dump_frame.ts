import { initCamera } from './src/server/tools/Camera';
import Pipe2Jpeg from 'pipe2jpeg';
import { writeFileSync } from 'fs';

async function test() {
    const { stream: video } = await initCamera();
    const p2j = new Pipe2Jpeg();
    video.pipe(p2j);

    p2j.once('data', (jpegBuffer: Buffer) => {
        writeFileSync('test_frame.jpg', jpegBuffer);
        console.log('Saved test_frame.jpg');
        process.exit(0);
    });
}
test();
