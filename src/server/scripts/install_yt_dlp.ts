import { chmod, mkdir, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';

const DEFAULT_VERSION = '2025.05.22';
const version = process.env.YT_DLP_VERSION || DEFAULT_VERSION;
const targetPath = resolve(process.env.YT_DLP_BIN || 'src/server/tools/bin/yt-dlp');
const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/yt-dlp`;

async function main() {
  await mkdir(dirname(targetPath), { recursive: true });

  console.log(`[yt-dlp] downloading ${downloadUrl}`);
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download yt-dlp ${version}: HTTP ${response.status}`);
  }

  await writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
  await chmod(targetPath, 0o755);
  console.log(`[yt-dlp] installed to ${targetPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
