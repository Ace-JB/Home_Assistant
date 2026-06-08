import { serve } from "bun";
import index from "@/index.html";
import { GLOBAL_CONFIG } from "@/global_config";
import { realtimeSocket, stopRealtimeSocketServer } from "@tools/Socket";
import type { SocketClientData } from "@tools/Socket";
import { WebRTCManager } from "@tools/WebRTC";
import path from "path";
import { startMonitor, stopMonitor } from "./monitor";
import { LifecycleManager } from "./lifecycle";
import { memory, type MemoryCandidateStatus, type MemoryLocation, type MemoryStatus } from "@modules/memory";
import { db } from "@server/db";
import {
  checkCosyVoiceService,
  createYtDlpAudioPreviewStream,
  extractCosyVoiceMaterial,
  getCosyVoiceMaterialConfig,
  getYtDlpStatus,
  importCosyVoiceMaterialFromUrl,
  installYtDlp,
  listCosyVoiceSpeakerProfiles,
  probeYtDlpAudioFormats,
  deleteCosyVoiceSpeakerProfile,
  resolveCosyVoiceAudioFile,
  resolveCosyVoiceVideoFile,
  saveCosyVoiceMaterial,
  selectCosyVoiceSpeakerProfile,
} from "@server/services/CosyVoiceMaterialService";
import {
  getDashboardServiceLogs,
  getDashboardStatus,
  startDashboardService,
  stopAllDashboardManagedServices,
  stopDashboardService,
} from "@server/services/DashboardService";
import { benchmarkService, type BenchmarkRunInput, type BenchmarkScenarioId } from "@server/services/BenchmarkService";
import { pipelineLogs } from "@server/services/PipelineLogService";

const serverStartedAt = Date.now();

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

    "/api/dashboard/status": {
      async GET() {
        return Response.json(await getDashboardStatus());
      },
    },

    "/api/dashboard/services/:serviceId/start": {
      async POST(req: Request) {
        const serviceId = getDashboardServiceIdFromUrl(req, "start");
        if (!serviceId) {
          return Response.json({ error: "serviceId is required" }, { status: 400 });
        }
        try {
          return Response.json({ service: await startDashboardService(serviceId) });
        } catch (error) {
          console.error("[Dashboard] start failed:", error);
          return Response.json({ error: error instanceof Error ? error.message : "start failed" }, { status: 400 });
        }
      },
    },

    "/api/dashboard/services/:serviceId/stop": {
      async POST(req: Request) {
        const serviceId = getDashboardServiceIdFromUrl(req, "stop");
        if (!serviceId) {
          return Response.json({ error: "serviceId is required" }, { status: 400 });
        }
        try {
          return Response.json({ service: await stopDashboardService(serviceId) });
        } catch (error) {
          console.error("[Dashboard] stop failed:", error);
          return Response.json({ error: error instanceof Error ? error.message : "stop failed" }, { status: 400 });
        }
      },
    },

    "/api/dashboard/services/:serviceId/logs": {
      GET(req: Request) {
        const serviceId = getDashboardServiceIdFromUrl(req, "logs");
        if (!serviceId) {
          return Response.json({ error: "serviceId is required" }, { status: 400 });
        }
        const url = new URL(req.url);
        const limit = Number(url.searchParams.get("limit") ?? 200);
        try {
          return Response.json({ logs: getDashboardServiceLogs(serviceId, limit) });
        } catch (error) {
          console.error("[Dashboard] logs failed:", error);
          return Response.json({ error: error instanceof Error ? error.message : "logs failed" }, { status: 400 });
        }
      },
    },

    "/api/pipeline-logs": {
      GET(req: Request) {
        const url = new URL(req.url);
        const kind = url.searchParams.get("kind");
        const status = url.searchParams.get("status");
        const limit = Number(url.searchParams.get("limit") ?? 100);
        return Response.json({
          pipelines: pipelineLogs.listPipelines({ kind, status, limit }),
          limit,
          kind,
          status,
        });
      },
      DELETE() {
        pipelineLogs.clear();
        return Response.json({ ok: true });
      },
    },

    "/api/pipeline-logs/:pipelineId": {
      GET(req: Request) {
        const pipelineId = getPipelineIdFromUrl(req);
        if (!pipelineId) {
          return Response.json({ error: "pipelineId is required" }, { status: 400 });
        }
        const pipeline = pipelineLogs.getPipelineDetail(pipelineId);
        if (!pipeline) {
          return Response.json({ error: "pipeline not found" }, { status: 404 });
        }
        const { events, ...pipelineSummary } = pipeline;
        return Response.json({ pipeline: pipelineSummary, events });
      },

      DELETE(req: Request) {
        const pipelineId = getPipelineIdFromUrl(req);
        if (!pipelineId) {
          return Response.json({ error: "pipelineId is required" }, { status: 400 });
        }
        return Response.json({ removed: pipelineLogs.removePipeline(pipelineId) });
      },
    },

    "/api/pipeline-model-calls": {
      GET(req: Request) {
        const url = new URL(req.url);
        const pipelineId = url.searchParams.get("pipelineId") ?? undefined;
        const limit = Number(url.searchParams.get("limit") ?? 100);
        return Response.json({ modelCalls: pipelineLogs.listModelCalls({ pipelineId, limit }) });
      },
    },

    "/api/pipeline-model-calls/:modelCallId": {
      GET(req: Request) {
        const modelCallId = getModelCallIdFromUrl(req);
        if (!modelCallId) {
          return Response.json({ error: "modelCallId is required" }, { status: 400 });
        }
        const modelCall = pipelineLogs.getModelCall(modelCallId);
        if (!modelCall) {
          return Response.json({ error: "model call not found" }, { status: 404 });
        }
        const incidents = pipelineLogs.listIncidents({ pipelineId: modelCall.pipelineId })
          .filter(incident => {
            const metadata = incident.metadata && typeof incident.metadata === "object" && !Array.isArray(incident.metadata)
              ? incident.metadata as Record<string, unknown>
              : {};
            return metadata.modelCallId === modelCall.id || incident.eventId === modelCall.eventId;
          });
        return Response.json({
          modelCall,
          pipeline: pipelineLogs.getPipeline(modelCall.pipelineId),
          incidents,
        });
      },

      DELETE(req: Request) {
        const modelCallId = getModelCallIdFromUrl(req);
        if (!modelCallId) {
          return Response.json({ error: "modelCallId is required" }, { status: 400 });
        }
        return Response.json({ removed: pipelineLogs.removeModelCall(modelCallId) });
      },
    },

    "/api/pipeline-incidents": {
      GET(req: Request) {
        const url = new URL(req.url);
        const pipelineId = url.searchParams.get("pipelineId") ?? undefined;
        const limit = Number(url.searchParams.get("limit") ?? 100);
        return Response.json({ incidents: pipelineLogs.listIncidents({ pipelineId, limit }) });
      },
    },

    "/api/pipeline-incidents/:incidentId": {
      GET(req: Request) {
        const incidentId = getIncidentIdFromUrl(req);
        if (!incidentId) {
          return Response.json({ error: "incidentId is required" }, { status: 400 });
        }
        const incident = pipelineLogs.getIncident(incidentId);
        if (!incident) {
          return Response.json({ error: "incident not found" }, { status: 404 });
        }
        return Response.json({
          incident,
          pipeline: pipelineLogs.getPipeline(incident.pipelineId),
        });
      },

      DELETE(req: Request) {
        const incidentId = getIncidentIdFromUrl(req);
        if (!incidentId) {
          return Response.json({ error: "incidentId is required" }, { status: 400 });
        }
        return Response.json({ removed: pipelineLogs.removeIncident(incidentId) });
      },
    },

    "/api/benchmarks/runs": {
      GET() {
        return Response.json({ runs: benchmarkService.listRuns() });
      },

      async POST(req: Request) {
        try {
          const body = await req.json().catch(() => ({})) as BenchmarkRunInput;
          const result = await benchmarkService.run({
            ...body,
            scenarioIds: parseBenchmarkScenarioIds(body.scenarioIds),
          });
          return Response.json({ run: result });
        } catch (error) {
          console.error("[Benchmark] run failed:", error);
          return Response.json({ error: error instanceof Error ? error.message : "benchmark failed" }, { status: 400 });
        }
      },
    },

    "/api/benchmarks/runs/:runId": {
      GET(req: Request) {
        const runId = getBenchmarkRunIdFromUrl(req);
        if (!runId) {
          return Response.json({ error: "runId is required" }, { status: 400 });
        }
        return Response.json({ run: benchmarkService.getRun(runId) });
      },
    },

    "/api/benchmarks/compare": {
      GET(req: Request) {
        const url = new URL(req.url);
        const runIds = url.searchParams.get("runIds")
          ?.split(",")
          .map(item => item.trim())
          .filter(Boolean) ?? [];
        if (runIds.length === 0) {
          return Response.json({ error: "runIds is required" }, { status: 400 });
        }
        return Response.json(benchmarkService.compare(runIds));
      },
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

        const body = await req.json().catch(() => null) as {
          instruction?: unknown;
          instructions?: unknown;
          purpose?: unknown;
        } | null;
        const instruction = parsePruneInstructions(body);
        const { normalizeMemoryPrunePurpose } = await import("@server/prompts");
        const purpose = normalizeMemoryPrunePurpose(body?.purpose);

        const { pruneConversationForMemory } = await import("@server/modules/brain");
        const draft = await pruneConversationForMemory(
          conversation.messages,
          realtimeSocket.getAssistantLanguage(),
          instruction,
          purpose,
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

    "/api/memory-candidates": {
      GET(req: Request) {
        const url = new URL(req.url);
        const status = parseMemoryCandidateStatus(url.searchParams.get("status"));
        const sourceConversationId = url.searchParams.get("sourceConversationId") ?? undefined;
        const query = url.searchParams.get("query") ?? undefined;
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const offset = Number(url.searchParams.get("offset") ?? 0);

        const candidates = memory.searchMemoryCandidates({ status, sourceConversationId, query, limit, offset });
        return Response.json({ candidates, limit, offset });
      },
    },

    "/api/memory-candidates/:candidateId/approve": {
      async POST(req: Request) {
        const candidateId = getMemoryCandidateIdFromUrl(req, "approve");
        if (!candidateId) {
          return Response.json({ error: "candidateId is required" }, { status: 400 });
        }

        const candidate = memory.getMemoryCandidate(candidateId);
        if (!candidate) {
          return Response.json({ error: "candidate not found" }, { status: 404 });
        }

        const body = await req.json().catch(() => null) as { content?: unknown; location?: unknown } | null;
        const content = typeof body?.content === "string" && body.content.trim()
          ? body.content.trim()
          : candidate.draftJson;
        const draft = parseMemoryDraft(content, body?.location);
        const prunedMemory = memory.approveMemoryCandidate(candidateId, draft);
        if (!prunedMemory) {
          return Response.json({ error: "candidate not found" }, { status: 404 });
        }

        return Response.json({ prunedMemory, candidate: memory.getMemoryCandidate(candidateId) });
      },
    },

    "/api/memory-candidates/:candidateId/reject": {
      POST(req: Request) {
        const candidateId = getMemoryCandidateIdFromUrl(req, "reject");
        if (!candidateId) {
          return Response.json({ error: "candidateId is required" }, { status: 400 });
        }

        const candidate = memory.rejectMemoryCandidate(candidateId);
        if (!candidate) {
          return Response.json({ error: "candidate not found" }, { status: 404 });
        }

        return Response.json({ candidate });
      },
    },

    "/api/voice/cosyvoice/config": {
      async GET() {
        return Response.json({
          config: getCosyVoiceMaterialConfig(),
          speakers: await listCosyVoiceSpeakerProfiles(),
        });
      },
    },

    "/api/voice/cosyvoice/speakers": {
      async GET() {
        return Response.json({ speakers: await listCosyVoiceSpeakerProfiles() });
      },
    },

    "/api/voice/cosyvoice/speakers/select": {
      async POST(req: Request) {
        const body = await req.json().catch(() => null) as { speakerId?: unknown } | null;
        try {
          const result = await selectCosyVoiceSpeakerProfile(
            typeof body?.speakerId === "string" ? body.speakerId : "",
          );
          return Response.json(result);
        } catch (error) {
          console.error("[CosyVoiceMaterial] select speaker failed:", error);
          return Response.json({ error: error instanceof Error ? error.message : "select failed" }, { status: 400 });
        }
      },
    },

    "/api/voice/cosyvoice/speakers/delete": {
      async POST(req: Request) {
        const body = await req.json().catch(() => null) as { speakerId?: unknown } | null;
        try {
          const result = await deleteCosyVoiceSpeakerProfile(
            typeof body?.speakerId === "string" ? body.speakerId : "",
          );
          return Response.json(result);
        } catch (error) {
          console.error("[CosyVoiceMaterial] delete speaker failed:", error);
          return Response.json({ error: error instanceof Error ? error.message : "delete failed" }, { status: 400 });
        }
      },
    },

    "/api/voice/cosyvoice/status": {
      async POST(req: Request) {
        const body = await req.json().catch(() => null) as { baseUrl?: unknown; endpoint?: unknown } | null;
        const status = await checkCosyVoiceService(
          typeof body?.baseUrl === "string" ? body.baseUrl : undefined,
          typeof body?.endpoint === "string" ? body.endpoint : undefined,
        );
        return Response.json({ status }, { status: status.ok ? 200 : 503 });
      },
    },

    "/api/voice/cosyvoice/extract": {
      async POST(req: Request) {
        try {
          const form = await req.formData();
          const video = form.get("video");
          if (!(video instanceof File)) {
            return Response.json({ error: "video is required" }, { status: 400 });
          }

          const result = await extractCosyVoiceMaterial(video, {
            enhanceVocals: form.get("enhanceVocals") === "1",
          });
          return Response.json(result);
        } catch (error) {
          console.error("[CosyVoiceMaterial] extract failed:", error);
          return Response.json({ error: error instanceof Error ? error.message : "extract failed" }, { status: 400 });
        }
      },
    },

    "/api/voice/cosyvoice/probe-url": {
      async POST(req: Request) {
        const body = await req.json().catch(() => null) as { url?: unknown; resourceType?: unknown } | null;
        if (body?.resourceType !== "audio") {
          return Response.json({ error: "Only audio resources are supported" }, { status: 400 });
        }

        try {
          const result = await probeYtDlpAudioFormats(typeof body.url === "string" ? body.url : "");
          return Response.json(result);
        } catch (error) {
          console.error("[CosyVoiceMaterial] probe-url failed:", error);
          return Response.json({ error: error instanceof Error ? error.message : "probe failed" }, { status: 400 });
        }
      },
    },

    "/api/voice/cosyvoice/yt-dlp/status": {
      async GET() {
        return Response.json({ status: await getYtDlpStatus() });
      },
    },

    "/api/voice/cosyvoice/yt-dlp/install": {
      async POST() {
        try {
          return Response.json({ status: await installYtDlp() });
        } catch (error) {
          console.error("[CosyVoiceMaterial] yt-dlp install failed:", error);
          return Response.json({ error: error instanceof Error ? error.message : "install failed" }, { status: 400 });
        }
      },
    },

    "/api/voice/cosyvoice/import-url": {
      async POST(req: Request) {
        const body = await req.json().catch(() => null) as { url?: unknown; formatId?: unknown; enhanceVocals?: unknown } | null;

        try {
          const result = await importCosyVoiceMaterialFromUrl(
            typeof body?.url === "string" ? body.url : "",
            typeof body?.formatId === "string" ? body.formatId : "",
            { enhanceVocals: body?.enhanceVocals === true },
          );
          return Response.json(result);
        } catch (error) {
          console.error("[CosyVoiceMaterial] import-url failed:", error);
          return Response.json({ error: error instanceof Error ? error.message : "import failed" }, { status: 400 });
        }
      },
    },

    "/api/voice/cosyvoice/preview-url": {
      GET(req: Request) {
        try {
          const url = new URL(req.url);
          const stream = createYtDlpAudioPreviewStream(
            url.searchParams.get("url") ?? "",
            url.searchParams.get("formatId") ?? "",
          );
          return new Response(stream, {
            headers: {
              "Content-Type": "application/octet-stream",
              "Cache-Control": "no-store",
            },
          });
        } catch (error) {
          console.error("[CosyVoiceMaterial] preview-url failed:", error);
          return new Response(error instanceof Error ? error.message : "preview failed", { status: 400 });
        }
      },
    },

    "/api/voice/cosyvoice/save": {
      async POST(req: Request) {
        const body = await req.json().catch(() => null) as {
          provider?: unknown;
          baseUrl?: unknown;
          endpoint?: unknown;
          promptAudioPath?: unknown;
          promptText?: unknown;
          speakerId?: unknown;
          speakerName?: unknown;
          timeoutMs?: unknown;
          fallbackToSay?: unknown;
        } | null;

        try {
          const result = await saveCosyVoiceMaterial({
            provider: body?.provider === "say" ? "say" : "cosyvoice",
            baseUrl: typeof body?.baseUrl === "string" ? body.baseUrl : "",
            endpoint: typeof body?.endpoint === "string" ? body.endpoint : "",
            speakerId: typeof body?.speakerId === "string" ? body.speakerId : "",
            speakerName: typeof body?.speakerName === "string" ? body.speakerName : "",
            promptAudioPath: typeof body?.promptAudioPath === "string" ? body.promptAudioPath : "",
            promptText: typeof body?.promptText === "string" ? body.promptText : "",
            timeoutMs: typeof body?.timeoutMs === "number" ? body.timeoutMs : Number(body?.timeoutMs),
            fallbackToSay: body?.fallbackToSay === true,
          });
          return Response.json(result);
        } catch (error) {
          console.error("[CosyVoiceMaterial] save failed:", error);
          return Response.json({ error: error instanceof Error ? error.message : "save failed" }, { status: 400 });
        }
      },
    },

    "/api/voice/cosyvoice/audio/:fileName": {
      async GET(req: Request) {
        const fileName = getCosyVoiceAudioFileNameFromUrl(req);
        if (!fileName) {
          return new Response("audio file is required", { status: 400 });
        }

        const audioPath = await resolveCosyVoiceAudioFile(fileName);
        if (!audioPath) {
          return new Response("audio not found", { status: 404 });
        }

        return new Response(Bun.file(audioPath), {
          headers: {
            "Content-Type": "audio/wav",
            "Cache-Control": "no-store",
          },
        });
      },
    },

    "/api/voice/cosyvoice/video/:fileName": {
      async GET(req: Request) {
        const fileName = getCosyVoiceVideoFileNameFromUrl(req);
        if (!fileName) {
          return new Response("video file is required", { status: 400 });
        }

        const videoPath = await resolveCosyVoiceVideoFile(fileName);
        if (!videoPath) {
          return new Response("video not found", { status: 404 });
        }

        return new Response(Bun.file(videoPath), {
          headers: {
            "Content-Type": getVideoContentType(videoPath),
            "Cache-Control": "no-store",
          },
        });
      },
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

LifecycleManager.registerShutdownTask('monitor runtime', stopMonitor);
LifecycleManager.registerShutdownTask('WebRTC runtime', () => {
  webrtcManager?.shutdown();
});
LifecycleManager.registerShutdownTask('realtime socket server', stopRealtimeSocketServer);
LifecycleManager.registerShutdownTask('HTTP server', () => {
  server.stop(true);
});
LifecycleManager.registerShutdownTask('Python model services', stopAllDashboardManagedServices);
LifecycleManager.registerShutdownTask('SQLite databases', () => {
  db.close();
  memory.close();
  pipelineLogs.close();
});

console.log(`🚀 Server running at ${server.url}`);
pipelineLogs.append({
  category: 'system',
  level: 'info',
  title: 'system.ready',
  message: `Server running at ${server.url}`,
  timings: [{ key: 'server_startup', label: 'Server startup', durationMs: Date.now() - serverStartedAt }],
  metadata: {
    port: GLOBAL_CONFIG.SERVER.PORT,
    demoMode,
    url: String(server.url),
  },
  pipelineId: 'system',
});
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

function getMemoryCandidateIdFromUrl(req: Request, action: "approve" | "reject"): string | null {
  const url = new URL(req.url);
  const match = url.pathname.match(new RegExp(`^/api/memory-candidates/([^/]+)/${action}$`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function getDashboardServiceIdFromUrl(req: Request, action: "start" | "stop" | "logs"): string | null {
  const url = new URL(req.url);
  const suffix = action === "logs" ? "logs" : action;
  const match = url.pathname.match(new RegExp(`^/api/dashboard/services/([^/]+)/${suffix}$`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function getPipelineIdFromUrl(req: Request): string | null {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/pipeline-logs\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function getModelCallIdFromUrl(req: Request): string | null {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/pipeline-model-calls\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function getIncidentIdFromUrl(req: Request): string | null {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/pipeline-incidents\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function getBenchmarkRunIdFromUrl(req: Request): string | null {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/benchmarks\/runs\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function parseBenchmarkScenarioIds(value: BenchmarkRunInput["scenarioIds"]): BenchmarkScenarioId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set<BenchmarkScenarioId>([
    "plain_chat_short",
    "direct_qa",
    "follow_up_context",
    "memory_recall",
    "vision_summary",
    "conversation_end",
  ]);
  return value.filter((item): item is BenchmarkScenarioId => allowed.has(item as BenchmarkScenarioId));
}

function getCosyVoiceAudioFileNameFromUrl(req: Request): string | null {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/voice\/cosyvoice\/audio\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function getCosyVoiceVideoFileNameFromUrl(req: Request): string | null {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/voice\/cosyvoice\/video\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function getVideoContentType(filePath: string): string {
  if (filePath.endsWith(".webm")) return "video/webm";
  if (filePath.endsWith(".mov")) return "video/quicktime";
  if (filePath.endsWith(".mkv")) return "video/x-matroska";
  return "video/mp4";
}

function parsePruneInstructions(body: { instruction?: unknown; instructions?: unknown } | null): string | undefined {
  const values: string[] = [];
  if (typeof body?.instruction === "string" && body.instruction.trim()) {
    values.push(body.instruction.trim());
  }
  if (typeof body?.instructions === "string" && body.instructions.trim()) {
    values.push(body.instructions.trim());
  }
  if (Array.isArray(body?.instructions)) {
    for (const item of body.instructions) {
      if (typeof item === "string" && item.trim()) {
        values.push(item.trim());
      }
    }
  }
  return values.length ? values.join("\n") : undefined;
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

function parseMemoryCandidateStatus(value: unknown): MemoryCandidateStatus | undefined {
  return value === "pending" || value === "approved" || value === "rejected" ? value : undefined;
}
