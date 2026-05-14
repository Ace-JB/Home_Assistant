/**
 * 这个脚本的主要功能是下载并存储 Human 模型文件，以便在后续的 FaceEngine 模块中使用。
 * 由于 Human 模型文件较大，且不适合直接包含在代码库中，因此我们通过这个脚本从官方仓库下载所需的模型。
 * 后续考虑配置模型组，以支持不同的功能需求（如仅人脸检测、完整识别等）。
 */


import fs from 'fs';
import path from 'path';
import https from 'https';
import { spawn } from 'child_process';
import { GLOBAL_CONFIG } from '@/global_config';

// 定义模型存放路径
const MODEL_DIR = path.join(process.cwd(), GLOBAL_CONFIG.MODELS.METADATA_DIR);
const BASE_URL = 'https://raw.githubusercontent.com/vladmandic/human/master/models/';

// 根据 FaceEngine 配置，需要下载以下模型
// face: detector / mesh / description / iris / emotion
// body: movenet-lightning
// hand: handtrack / handlandmark-lite
// object: nanodet
const models = [
  // --- 人脸检测与识别 ---
  'blazeface.json', 'blazeface.bin',             // 基础人脸检测器 (face.detector)
  'facemesh.json', 'facemesh.bin',               // 面部特征网格 (face.mesh)
  'faceres.json', 'faceres.bin',                 // 特征识别/比对 Embedding (face.description)
  'iris.json', 'iris.bin',                       // 虹膜追踪 (face.iris)
  'emotion.json', 'emotion.bin',                 // 情绪识别 (face.emotion)
  // --- 肢体姿态 ---
  'movenet-lightning.json', 'movenet-lightning.bin', // 身体姿态估计 (body)
  // --- 手部追踪 ---
  'handtrack.json', 'handtrack.bin',             // 手部检测 (hand)
  'handlandmark-lite.json', 'handlandmark-lite.bin', // 手部关键点 (hand)
  // --- 物体检测 ---
  'centernet.json', 'centernet.bin',             // 物体检测 (object)
];

// 确保目录存在
if (!fs.existsSync(MODEL_DIR)) {
  fs.mkdirSync(MODEL_DIR, { recursive: true });
}

async function downloadFile(fileName: string): Promise<void> {
  const url = `${BASE_URL}${fileName}`;
  const filePath = path.join(MODEL_DIR, fileName);

  // 如果同名文件已存在，则不进行下载
  if (fs.existsSync(filePath)) {
    console.log(`⚠️ 已存在: ${fileName}，跳过下载`);
    return;
  }

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`下载失败: ${fileName} (状态码: ${response.statusCode})`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`✅ 已下载: ${fileName}`);
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(filePath, () => { });
      reject(err);
    });
  });
}

async function load_models() {
  console.log(`🚀 开始下载 Human 模型文件... 到 ${MODEL_DIR}`);
  try {
    for (const model of models) {
      await downloadFile(model);
    }
    console.log('\n✨ 所有模型已就绪！存放在: ' + MODEL_DIR);
  } catch (error: any) {
    console.error('\n❌ 下载过程中出错:', error.message);
  }
}

async function main() {
  await load_models();
}

main().catch((error: any) => {
  console.error('\n❌ 模型准备失败:', error.message);
  process.exit(1);
});
