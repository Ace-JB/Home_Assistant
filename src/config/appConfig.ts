import { getEnvString } from './env';

export const appConfig = {
  apiBaseUrl: getEnvString('VITE_API_BASE_URL', 'http://localhost:3000'),
  socketUrl: getEnvString('VITE_SOCKET_URL', 'ws://localhost:3001/ws/realtime'),
  modelBasePath: getEnvString('VITE_MODEL_BASE_PATH', '/models'),
};
