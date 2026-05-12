import Pipe2Jpeg from 'pipe2jpeg';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, resolve } from 'path';
import { db } from '@/server/db';
import { faceEngine } from '@/server/modules/media/face';
import { initCamera } from '@/server/tools/Camera';

interface RegisterFaceOptions {
  name: string;
  imagePath?: string;
  useCamera: boolean;
  outputPath: string;
  settleFrames: number;
  timeoutMs: number;
}

const DEFAULT_CAPTURE_PATH = join(process.cwd(), 'src', 'server', 'temp_cache', 'registered_face.jpg');

function printUsage(): void {
  console.log(`
Usage:
  bun src/server/scripts/register_face.ts --name <member-name> --image <image-path>
  bun src/server/scripts/register_face.ts --name <member-name> --camera

Options:
  --name <value>          Family member name to save in face_db.json.
  --image <path>          Register from a local portrait image.
  --camera                Capture a frame from the configured camera and register it.
  --output <path>         Save the captured camera frame. Default: ${DEFAULT_CAPTURE_PATH}
  --settle-frames <num>   Skip early camera frames before capture. Default: 3
  --timeout-ms <num>      Camera capture timeout. Default: 15000
  --help                  Show this help.

Examples:
  bun src/server/scripts/register_face.ts --name 主人 --image ./portrait.jpg
  bun src/server/scripts/register_face.ts --name 主人 --camera
`);
}

function readOption(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  if (index === -1) return undefined;
  return args[index + 1];
}

function hasFlag(args: string[], key: string): boolean {
  return args.includes(key);
}

function toPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePath(inputPath: string): string {
  return isAbsolute(inputPath) ? inputPath : resolve(process.cwd(), inputPath);
}

function parseArgs(args: string[]): RegisterFaceOptions {
  if (args.length === 0 || hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const name = readOption(args, '--name')?.trim();
  const imagePath = readOption(args, '--image');
  const useCamera = hasFlag(args, '--camera');

  if (!name) {
    throw new Error('Missing required option: --name <member-name>');
  }

  if (!imagePath && !useCamera) {
    throw new Error('Please provide either --image <path> or --camera.');
  }

  if (imagePath && useCamera) {
    throw new Error('Please choose only one source: --image or --camera.');
  }

  return {
    name,
    imagePath: imagePath ? resolvePath(imagePath) : undefined,
    useCamera,
    outputPath: resolvePath(readOption(args, '--output') ?? DEFAULT_CAPTURE_PATH),
    settleFrames: toPositiveInteger(readOption(args, '--settle-frames'), 3),
    timeoutMs: toPositiveInteger(readOption(args, '--timeout-ms'), 15_000),
  };
}

async function captureFrameFromCamera(options: RegisterFaceOptions): Promise<Buffer> {
  console.log('📷 正在从摄像头采集人像帧...');
  const { stream, stop } = await initCamera();
  const parser = new Pipe2Jpeg();

  return new Promise<Buffer>((resolveCapture, rejectCapture) => {
    let frameCount = 0;
    let settled = false;

    const cleanup = async () => {
      stream.unpipe(parser);
      parser.removeAllListeners();
      stream.destroy();
      await stop().catch(() => undefined);
    };

    const finish = (buffer?: Buffer, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void cleanup().finally(() => {
        if (error) {
          rejectCapture(error);
          return;
        }

        resolveCapture(buffer!);
      });
    };

    const timeout = setTimeout(() => {
      finish(undefined, new Error(`Camera capture timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);

    parser.on('data', (jpegBuffer: Buffer) => {
      frameCount++;
      if (frameCount < options.settleFrames) {
        return;
      }

      finish(jpegBuffer);
    });

    parser.on('error', (error: Error) => {
      finish(undefined, error);
    });

    stream.pipe(parser);
  });
}

async function registerFromBuffer(name: string, imageBuffer: Buffer): Promise<void> {
  await faceEngine.loadModels();
  const descriptor = await faceEngine.extractDescriptor(imageBuffer);

  if (!descriptor) {
    throw new Error('No face descriptor was extracted. Please use a clear frontal portrait.');
  }

  db.save(name, descriptor);
  console.log(`✅ 已完成 ${name} 的人脸特征注册`);
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));

  if (options.imagePath) {
    console.log(`🖼️ 正在读取图片: ${options.imagePath}`);
    await faceEngine.registerUser(options.name, options.imagePath);
    console.log(`✅ 已完成 ${options.name} 的人脸特征注册`);
    return;
  }

  const imageBuffer = await captureFrameFromCamera(options);
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, imageBuffer);
  console.log(`💾 已保存摄像头采集帧: ${options.outputPath}`);

  await registerFromBuffer(options.name, imageBuffer);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`❌ 人脸注册失败: ${message}`);
  process.exit(1);
});
