import { tool, jsonSchema } from 'ai';
import { faceEngine } from '@/server/modules/media/face';
import path from 'path';
import fs from 'fs';

const LATEST_FRAME_PATH = path.join(process.cwd(), 'src', 'server', 'temp_cache', 'frame.jpg');

export const MY_TOOLS = {
    // camera tools
    startCamera: tool({
        description: "Start the camera stream",
        parameters: jsonSchema({ type: 'object', properties: {}, required: [] }),
        execute: async () => {
            // await cameraStream.start();
            return `start camera successfully`;
        }
    }),

    stopCamera: tool(
        {
            description: "Stop the camera stream",
            parameters: jsonSchema({ type: 'object', properties: {}, required: [] }),
            execute: async () => {
                // await cameraStream.stop();
                return `stop camera successfully`;
            }
        }
    ),

    // face recognition tools
    recognize: tool(
        {
            description: "Get the face information",
            parameters: jsonSchema({ type: 'object', properties: {}, required: [] }),
            execute: async () => {
                return faceEngine.recognizeFaces(fs.readFileSync(LATEST_FRAME_PATH));
            }
        }
    )
}
