import { execSync } from 'child_process';

/**
 * 手动终止视频和语音相关的残留进程 (ffmpeg, whisper-cli, say)
 * 适用于 Sentinel 系统出现资源占用不释放或摄像头无法再次开启时手动清理。
 * 
 * 使用方式: bun run src/server/scripts/terminate_media.ts
 */

const TARGET_PROCESS_NAMES = ['ffmpeg', 'say'];

function terminateProcesses() {
    console.log('🔍 正在扫描媒体流进程 (ffmpeg)...');
    
    try {
        // 获取进程列表
        const psOutput = execSync('ps aux').toString();
        const lines = psOutput.split('\n');
        
        const victims: { pid: string; cmd: string }[] = [];
        
        for (const line of lines) {
            const lowerLine = line.toLowerCase();
            
            // 匹配目标进程名称
            const hasTargetName = TARGET_PROCESS_NAMES.some(name => lowerLine.includes(name));
            
            // 排除 grep、ps 命令本身以及当前执行的脚本进程
            const isUtility = lowerLine.includes('grep') || lowerLine.includes('ps aux');
            const isSelf = lowerLine.includes('terminate_media.ts');
            
            if (hasTargetName && !isUtility && !isSelf) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[1];
                // 命令行内容通常从第 11 列开始 (索引 10)
                const cmd = parts.slice(10).join(' ');
                
                if (pid && !isNaN(Number(pid))) {
                    victims.push({ pid, cmd });
                }
            }
        }
        
        if (victims.length === 0) {
            console.log('✅ 未发现活跃的相关媒体进程。');
            return;
        }
        
        console.log(`🚀 发现 ${victims.length} 个活跃进程，正在执行强制终止 (SIGKILL)...`);
        
        let successCount = 0;
        for (const { pid, cmd } of victims) {
            try {
                process.kill(Number(pid), 'SIGKILL');
                console.log(`   💀 [PID ${pid}] ${cmd.slice(0, 100)}${cmd.length > 100 ? '...' : ''}`);
                successCount++;
            } catch (err: any) {
                console.error(`   ❌ 无法终止 PID ${pid}: ${err.message}`);
            }
        }
        
        console.log(`\n✨ 清理任务结束: 成功清理 ${successCount}/${victims.length} 个进程。`);
    } catch (error: any) {
        console.error('❌ 获取进程列表失败:', error.message);
    }
}

terminateProcesses();
