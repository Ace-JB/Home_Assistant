import { serve } from "bun";
import index from "@/index.html";
import { GLOBAL_CONFIG } from "@/global_config";
import { realtimeSocket } from "@tools/Socket";
import type { SocketClientData } from "@tools/Socket";
import { WebRTCManager } from "@tools/WebRTC";
import path from "path";
import { startMonitor } from "./monitor";
import { LifecycleManager } from "./lifecycle";
import { memory, type MemoryLocation, type MemoryStatus } from "@modules/memory";

// 初始化生命周期管理
LifecycleManager.init();

const demoMode = GLOBAL_CONFIG.SERVER.DEMO_MODE;
const demoPath = demoMode === 'video'
  ? '/demo/video'
  : demoMode === 'audio'
    ? '/demo/audio'
    : null;
const webrtcManager = demoMode === 'audio' ? null : new WebRTCManager();


const server = serve<SocketClientData>({
  port: GLOBAL_CONFIG.SERVER.PORT,
  routes: {
    "/": {
      GET() {
        if (demoPath) {
          return Response.redirect(demoPath, 302);
        }

        return index;
      },
    },

    [realtimeSocket.path]: {
      GET(req: Request, server: any) {
        return realtimeSocket.upgrade(req, server);
      },
    },

    ...(webrtcManager ? {
      "/webrtc": {
      GET(req: Request, server: any) {
        console.log("⚡ Upgrading WebRTC Connection...");
        const success = server.upgrade(req, { data: { isWebRTC: true } });
        console.log(`⚡ Upgrade Success: ${success}`);
        return success ? undefined : new Response("Upgrade failed", { status: 400 });
      },
      },
    } : {}),

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

    "/api/conversations": {
      GET(req: Request) {
        const url = new URL(req.url);
        const query = url.searchParams.get("query") ?? undefined;
        const conversationId = url.searchParams.get("conversationId") ?? undefined;
        const from = url.searchParams.get("from") ?? undefined;
        const to = url.searchParams.get("to") ?? undefined;
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const offset = Number(url.searchParams.get("offset") ?? 0);

        const options = {
          conversationId,
          query,
          from,
          to,
          limit,
          offset,
        };

        const conversations = memory.searchConversationSessions(options);
        const total = memory.countConversationSessions({ conversationId, query, from, to });

        return Response.json({ conversations, total, limit, offset });
      },
    },

    "/api/conversations/:conversationId": {
      DELETE(req: Request) {
        const conversationId = getConversationIdFromUrl(req);
        if (!conversationId) {
          return Response.json({ error: "conversationId is required" }, { status: 400 });
        }

        const removed = memory.removeConversationSession(conversationId);
        return Response.json({ removed });
      },
    },

    "/api/conversations/:conversationId/prune": {
      async POST(req: Request) {
        const conversationId = getConversationIdFromUrl(req);
        if (!conversationId) {
          return Response.json({ error: "conversationId is required" }, { status: 400 });
        }

        const conversation = memory.getConversationSession(conversationId);
        if (!conversation) {
          return Response.json({ error: "conversation not found" }, { status: 404 });
        }

        const body = await req.json().catch(() => null) as { instruction?: unknown } | null;
        const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : undefined;

        const { pruneConversationForMemory } = await import("@server/modules/brain");
        const draft = await pruneConversationForMemory(
          conversation.messages,
          realtimeSocket.getAssistantLanguage(),
          instruction,
        );

        return Response.json({ draft });
      },
    },

    "/api/conversations/:conversationId/memories": {
      async POST(req: Request) {
        const conversationId = getConversationIdFromUrl(req);
        if (!conversationId) {
          return Response.json({ error: "conversationId is required" }, { status: 400 });
        }

        const body = await req.json().catch(() => null) as { content?: unknown; location?: unknown } | null;
        const content = typeof body?.content === "string" ? body.content.trim() : "";
        if (!content) {
          return Response.json({ error: "content is required" }, { status: 400 });
        }

        const draft = parseMemoryDraft(content, body?.location);
        const prunedMemory = memory.savePrunedMemory({
          source_conversation_id: conversationId,
          ...draft,
        });

        return Response.json({ prunedMemory });
      },
    },

    "/api/memories": {
      GET(req: Request) {
        const url = new URL(req.url);
        const query = url.searchParams.get("query") ?? undefined;
        const sourceConversationId = url.searchParams.get("sourceConversationId") ?? undefined;
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const offset = Number(url.searchParams.get("offset") ?? 0);

        const memories = memory.searchPrunedMemories({ query, sourceConversationId, limit, offset });
        return Response.json({ memories, limit, offset });
      },
    },

    "/api/memories/:memoryId": {
      async PATCH(req: Request) {
        const memoryId = getMemoryIdFromUrl(req);
        if (!memoryId) {
          return Response.json({ error: "memoryId is required" }, { status: 400 });
        }

        const body = await req.json().catch(() => null) as { content?: unknown; location?: unknown } | null;
        const content = typeof body?.content === "string" ? body.content.trim() : "";
        if (!content) {
          return Response.json({ error: "content is required" }, { status: 400 });
        }

        const draft = parseMemoryDraft(content, body?.location);
        const prunedMemory = memory.updatePrunedMemory({ memory_id: memoryId, ...draft });
        if (!prunedMemory) {
          return Response.json({ error: "memory not found" }, { status: 404 });
        }

        return Response.json({ prunedMemory });
      },

      DELETE(req: Request) {
        const memoryId = getMemoryIdFromUrl(req);
        if (!memoryId) {
          return Response.json({ error: "memoryId is required" }, { status: 400 });
        }

        const removed = memory.removePrunedMemory(memoryId);
        return Response.json({ removed });
      },
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
        await webrtcManager?.handleSignaling(ws, message as string);
      } else {
        realtimeSocket.websocket.message(ws, message);
      }
    },
    close(ws: any) {
      if (ws.data?.isWebRTC) {
        console.log("🧊 WebRTC Signaling Connection Closed");
        webrtcManager?.stop();
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
if (demoPath) {
  console.log(`🧪 Demo mode: ${demoMode}. Open ${server.url}${demoPath}`);
}

// 启动后台监控 (摄像头、麦克风、语音识别等)
void startMonitor(demoMode);

function getConversationIdFromUrl(req: Request): string | null {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/conversations\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function getMemoryIdFromUrl(req: Request): string | null {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/memories\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

type ParsedMemoryDraft = {
  content: string;
  base_score?: number;
  status?: MemoryStatus;
  topic?: string;
  user_state?: string;
  behavior_signal?: string;
  interaction_result?: string;
  location?: MemoryLocation;
};

function parseMemoryDraft(content: string, locationValue?: unknown): ParsedMemoryDraft {
  const location = parseMemoryLocation(locationValue);
  const parsed = parseJsonLike(content);
  if (!parsed || typeof parsed !== "object") {
    return { content, location };
  }

  const record = parsed as Record<string, unknown>;
  const summary = objectValue(record.summary);
  const retention = objectValue(record.retention_evaluation);
  const directContent = stringValue(record.content);
  const topic = stringValue(record.topic) ?? stringValue(summary?.topic);
  const userState = stringValue(record.user_state) ?? stringValue(record.userState) ?? stringValue(summary?.user_state);
  const behaviorSignal = stringValue(record.behavior_signal)
    ?? stringValue(record.behaviorSignal)
    ?? stringValue(summary?.behavior_signal);
  const interactionResult = stringValue(record.interaction_result)
    ?? stringValue(record.interactionResult)
    ?? stringValue(record.result)
    ?? stringValue(summary?.interaction_result)
    ?? stringValue(summary?.result);
  const reason = stringValue(retention?.reason);
  const baseScore = numberValue(record.base_score)
    ?? numberValue(record.baseScore)
    ?? numberValue(retention?.recommendation_score);
  const status = parseMemoryStatus(record.status);

  return {
    content: directContent ?? buildMemoryContent({
      topic,
      userState,
      behaviorSignal,
      interactionResult,
      reason,
      fallback: content,
    }),
    base_score: baseScore,
    status,
    topic,
    user_state: userState,
    behavior_signal: behaviorSignal,
    interaction_result: interactionResult,
    location,
  };
}

function parseJsonLike(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function buildMemoryContent(input: {
  topic?: string;
  userState?: string;
  behaviorSignal?: string;
  interactionResult?: string;
  reason?: string;
  fallback: string;
}): string {
  const lines = [
    input.topic ? `Topic: ${input.topic}` : "",
    input.userState ? `User state: ${input.userState}` : "",
    input.behaviorSignal ? `Behavior signal: ${input.behaviorSignal}` : "",
    input.interactionResult ? `Interaction result: ${input.interactionResult}` : "",
    input.reason ? `Why it matters: ${input.reason}` : "",
  ].filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : input.fallback;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function parseMemoryStatus(value: unknown): MemoryStatus | undefined {
  return value === "warm" || value === "cold" ? value : undefined;
}

function parseMemoryLocation(value: unknown): MemoryLocation | undefined {
  return value === "living_room" || value === "bedroom" || value === "kitchen" || value === "unknown" ? value : undefined;
}
