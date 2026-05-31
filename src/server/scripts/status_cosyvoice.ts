import { checkCosyVoiceService } from '@server/services/CosyVoiceMaterialService';
import { getCosyVoicePaths, isCosyVoiceInstalled, loadRuntimeEnvForScript } from './cosyvoice_common';

loadRuntimeEnvForScript();

const paths = getCosyVoicePaths();
const service = await checkCosyVoiceService();

console.log(JSON.stringify({
    backend: 'mlx',
    installed: isCosyVoiceInstalled(paths.installDir),
    installDir: paths.installDir,
    modelDir: paths.modelDir,
    service,
}, null, 2));
