import { serve } from "bun";
import index from "@/index.html";
import { GLOBAL_CONFIG } from "@/global_config";
import { realtimeSocket } from "@/server/tools/Socket";
import type { SocketClientData } from "@/server/tools/Socket";
import { WebRTCManager } from "@/server/tools/WebRTC";
import path from "path";
import { startMonitor } from "./monitor";

const webrtcManager = new WebRTCManager();


const server = serve<SocketClientData>({
  port: GLOBAL_CONFIG.SERVER.PORT,
  routes: {
    [realtimeSocket.path]: {
      GET(req: Request, server: any) {
        return realtimeSocket.upgrade(req, server);
      },
    },

    "/webrtc": {
      GET(req: Request, server: any) {
        console.log("⚡ Upgrading WebRTC Connection...");
        const success = server.upgrade(req, { data: { isWebRTC: true } });
        console.log(`⚡ Upgrade Success: ${success}`);
        return success ? undefined : new Response("Upgrade failed", { status: 400 });
      },
    },

    "/models/*": async (req: Request) => {
      const url = new URL(req.url);
      const relativePath = url.pathname.replace("/models/", "");
      // 注意：模型文件实际存放在 metadata 子目录下
      const filePath = path.join(GLOBAL_CONFIG.MODELS.METADATA_DIR, relativePath);
      const file = Bun.file(filePath);

      if (await file.exists()) {
        return new Response(file);
      }
      return new Response(`Model not found: ${relativePath}`, { status: 404 });
    },

    "/human.worker.js": async () => {
      // 动态编译 Worker 为 JS 以供浏览器执行
      const build = await Bun.build({
        entrypoints: ["./src/human.worker.ts"],
        target: "browser",
        minify: true,
      });
      if (!build.success) return new Response("Build failed", { status: 500 });
      return new Response(build.outputs[0], {
        headers: { "Content-Type": "application/javascript" },
      });
    },

    // Serve index.html for all unmatched routes - MUST BE LAST
    "/*": index,
  } as any,



  websocket: {
    open(ws: any) {
      if (ws.data?.isWebRTC) {
        console.log("🧊 WebRTC Signaling Connection Opened");
      } else {
        // 只有 Metadata 客户端才进入 realtimeSocket 的管理逻辑
        realtimeSocket.websocket.open(ws);
      }
    },
    async message(ws: any, message: any) {
      if (ws.data?.isWebRTC) {
        await webrtcManager.handleSignaling(ws, message as string);
      } else {
        realtimeSocket.websocket.message(ws, message);
      }
    },
    close(ws: any) {
      if (ws.data?.isWebRTC) {
        console.log("🧊 WebRTC Signaling Connection Closed");
        webrtcManager.stop();
      } else {
        realtimeSocket.websocket.close(ws);
      }
    }
  },


  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
  error(error) {
    console.error(`${error.code}: ${error.message}`);
  },
});

console.log(`🚀 Server running at ${server.url}`);

// 启动后台监控 (摄像头、麦克风、语音识别等)
void startMonitor();
