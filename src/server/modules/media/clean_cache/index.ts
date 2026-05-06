import { GLOBAL_CONFIG } from '@/global_config';
import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * 定期清理超过指定期限的记录文件
 */
export async function data_cleaner() {
    const RECORDING_DIR = join(process.cwd(), 'recordings');
    const now = Date.now();
    const EXPIRE_MS = GLOBAL_CONFIG.CACHE.MAX_FILE_AGE;
    try {
        const folders = await fs.readdir(RECORDING_DIR);

        for (const folder of folders) {
            const fullPath = join(RECORDING_DIR, folder);
            const stats = await fs.stat(fullPath);

            // 如果文件的最后修改时间超过了设定期限
            if (now - stats.mtimeMs > EXPIRE_MS) {
                console.log(`🧹 正在清理过期资源: ${folder}`);
                await fs.rm(fullPath, { recursive: true, force: true });
            }
        }
    } catch (err) {
        console.error('❌ 清理任务失败:', err);
    }
}