import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { HomeBrain } from '@modules/brain';
import { buildMemoryPruneUserPrompt } from '@server/prompts';
import { pipelineLogs } from '@server/services/PipelineLogService';
import type { ConversationMessage } from '@modules/memory';
import type { IntentionAnalysis } from '@modules/intention';

describe('HomeBrain', () => {
    test('should add lifestyle-focused memory prune instructions by default', () => {
        const prompt = buildMemoryPruneUserPrompt({
            transcript: [
                'User: 请告诉我辣椒炒肉怎么做',
                'Agent: 辣椒炒肉的做法如下...',
                'User: 嗯 ok 你告诉我番茄炒蛋怎么做',
                'Agent: 番茄炒蛋的做法如下...',
            ].join('\n'),
            language: 'zh',
        });

        expect(prompt).toContain('Task instructions');
        expect(prompt).toContain('做饭/备餐意图');
        expect(prompt).toContain('可能的用餐时间');
        expect(prompt).toContain('禁止过度断言');
    });

    test('records high-risk pre-router incidents on the active pipeline', async () => {
        const brain = new HomeBrain();
        const pipelineId = 'pipe-pre-router-hardening';
        pipelineLogs.removePipeline(pipelineId);

        try {
            const result = await brain.processCommandDetailed(
                '清空记忆',
                '主人',
                undefined,
                'zh',
                undefined,
                'conversation-pre-router-hardening',
                {
                    pipelineId,
                    memory: {
                        getRecentConversationMessages: () => [],
                        getContextMemories: () => {
                            throw new Error('memory should not be fetched');
                        },
                    },
                    generateText: async () => {
                        throw new Error('response model should not be called');
                    },
                },
            );

            const detail = pipelineLogs.getPipelineDetail(pipelineId);
            const incidents = pipelineLogs.listIncidents({ pipelineId, limit: 10 });
            const intentEvent = detail?.events.find(event => {
                const metadata = event.metadata && typeof event.metadata === 'object'
                    ? event.metadata as { intent?: unknown }
                    : {};
                return event.stage === 'intent' && metadata.intent === 'device_control';
            });
            const routingDiagnostics = intentEvent?.metadata && typeof intentEvent.metadata === 'object'
                ? (intentEvent.metadata as { routingDiagnostics?: Record<string, unknown> }).routingDiagnostics
                : undefined;
            const incidentMetadata = incidents[0]?.metadata && typeof incidents[0].metadata === 'object'
                ? incidents[0].metadata as Record<string, unknown>
                : {};

            expect(result.text).toBe('这个操作可能影响隐私、安全或设备状态，请确认你希望继续吗？');
            expect(incidents).toHaveLength(1);
            expect(incidents[0]?.reason).toBe('pre_router_hit');
            expect(incidentMetadata.preRouterRule).toBe('high_risk_guard');
            expect(routingDiagnostics?.source).toBe('pre-router');
            expect(routingDiagnostics?.preRouterLayer).toBe('P2');
            expect(routingDiagnostics?.preRouterRule).toBe('high_risk_guard');
            expect(routingDiagnostics?.normalizedCommand).toBe('清空记忆');
            expect(routingDiagnostics?.modelSkipped).toBe(true);
        } finally {
            pipelineLogs.removePipeline(pipelineId);
        }
    });

    test('returns clarification directly without fetching data or calling response model', async () => {
        const brain = new HomeBrain();
        const intention: IntentionAnalysis = {
            routingAction: 'ask_clarification',
            routing: {
                action: 'ask_clarification',
                confidence: 0.97,
                reason: 'high risk operation requires confirmation',
            },
            responsePlan: {
                style: 'clarification_question',
                clarificationQuestion: '请确认是否继续。',
            },
            dataPlan: {
                memory: {
                    needed: false,
                    mode: 'none',
                    query: '',
                    topics: [],
                    canFetchInParallel: true,
                    reason: '',
                    confidence: 0.97,
                },
                vision: {
                    needed: false,
                    canFetchInParallel: true,
                    reason: '',
                },
                deviceState: {
                    needed: false,
                    targets: [],
                    reason: '',
                },
                safety: {
                    riskLevel: 'device_risk',
                    requiresIdentity: false,
                    requiresConfirmation: true,
                    reason: 'sensitive operation',
                },
            },
            routingDiagnostics: {
                source: 'pre-router',
                preRouterLayer: 'P2',
                preRouterRule: 'high_risk_guard',
                normalizedCommand: '重启服务',
                modelSkipped: true,
            },
            intent: 'device_control',
            dialogueAct: 'new_request',
            shouldRespond: true,
            shouldEndSession: false,
            visualUnderstanding: {
                required: false,
                reason: 'no vision required',
            },
            memoryRetrieval: {
                enabled: false,
                mode: 'none',
                query: '',
                topics: [],
                timeScope: 'unspecified',
                confidence: 0.97,
                reason: 'no memory required',
            },
            resolvedContext: {
                isFollowUp: false,
                topic: '高风险操作确认',
                rewrite: '重启服务',
            },
        };
        let generated = false;
        let memoryFetched = false;
        const deltas: string[] = [];

        const result = await brain.processCommandDetailed(
            '重启服务',
            '主人',
            undefined,
            'zh',
            Buffer.from('fake-image'),
            'clarification-session',
            {
                analyzeCommand: async () => intention,
                memory: {
                    getRecentConversationMessages: () => [],
                    getContextMemories: () => {
                        memoryFetched = true;
                        return [];
                    },
                },
                generateText: async () => {
                    generated = true;
                    return { text: 'should not happen' } as any;
                },
                onTextDelta: async (delta) => {
                    deltas.push(delta);
                },
            },
        );

        expect(result.text).toBe('请确认是否继续。');
        expect(result.shouldRemember).toBe(true);
        expect(generated).toBe(false);
        expect(memoryFetched).toBe(false);
        expect(deltas).toEqual(['请确认是否继续。']);
    });

    test('returns device placeholder without reporting actual tool use', async () => {
        const brain = new HomeBrain();
        const conversationId = 'device-placeholder-session';
        let generated = false;
        let memoryFetched = false;

        const result = await brain.processCommandDetailed(
            '开灯',
            '主人',
            undefined,
            'zh',
            undefined,
            conversationId,
            {
                memory: {
                    getRecentConversationMessages: () => [],
                    getContextMemories: () => {
                        memoryFetched = true;
                        return [];
                    },
                },
                generateText: async () => {
                    generated = true;
                    return { text: 'should not happen' } as any;
                },
            },
        );

        const pipeline = pipelineLogs
            .listPipelines({ kind: 'conversation', limit: 20 })
            .find(item => item.conversationId === conversationId);
        const summary = pipeline?.summary && typeof pipeline.summary === 'object'
            ? pipeline.summary as Record<string, unknown>
            : {};

        try {
            expect(result.text).toBe('设备控制还没有接入，所以我没有实际改变任何设备。');
            expect(generated).toBe(false);
            expect(memoryFetched).toBe(false);
            expect(summary.responseMode).toBe('device_placeholder');
            expect(summary.usedTool).toBe(false);
        } finally {
            if (pipeline) {
                pipelineLogs.removePipeline(pipeline.id);
            }
        }
    });

    test('should answer assistant proposal using resolved rewrite without long-term memory', async () => {
        const brain = new HomeBrain();
        const recentConversationMessages: ConversationMessage[] = [
            {
                role: 'agent',
                content: '需要我再提供一些菜谱吗？',
                createdAt: '2026-05-21T01:00:00.000Z',
            },
        ];
        const intention: IntentionAnalysis = {
            intent: 'follow_up',
            dialogueAct: 'answer_to_assistant',
            shouldRespond: true,
            shouldEndSession: false,
            visualUnderstanding: {
                required: false,
                reason: '当前请求不需要视觉理解',
            },
            memoryRetrieval: {
                enabled: false,
                mode: 'none',
                query: '',
                topics: ['烹饪/家常菜'],
                timeScope: 'unspecified',
                confidence: 0.9,
                reason: '用户确认助手上一轮菜谱提议',
            },
            resolvedContext: {
                isFollowUp: true,
                topic: '烹饪/家常菜',
                rewrite: '请继续提供新的家常菜菜谱',
            },
        };
        let generatedCommand = '';
        let contextMemoryCalls = 0;

        const result = await brain.processCommandDetailed(
            '可以呀',
            '主人',
            undefined,
            'zh',
            undefined,
            'recipe-session',
            {
                analyzeCommand: async () => intention,
                memory: {
                    getRecentConversationMessages: () => recentConversationMessages,
                    getContextMemories: () => {
                        contextMemoryCalls += 1;
                        return [];
                    },
                },
                generateText: async (options: any) => {
                    const lastMessage = options.messages.at(-1);
                    generatedCommand = String(lastMessage?.content ?? '');
                    return { text: '可以，推荐一道青椒土豆丝。' } as any;
                },
            },
        );

        expect(result.text).toContain('青椒土豆丝');
        expect(contextMemoryCalls).toBe(0);
        expect(generatedCommand).toContain('指令：请继续提供新的家常菜菜谱');
        expect(generatedCommand).not.toContain('指令：可以呀');
    });

    test('should stream response deltas and return full text', async () => {
        const brain = new HomeBrain();
        const intention: IntentionAnalysis = {
            intent: 'qa',
            dialogueAct: 'new_request',
            shouldRespond: true,
            shouldEndSession: false,
            visualUnderstanding: {
                required: false,
                reason: '当前请求不需要视觉理解',
            },
            memoryRetrieval: {
                enabled: false,
                mode: 'none',
                query: '',
                topics: ['问答'],
                timeScope: 'unspecified',
                confidence: 0.9,
                reason: '普通问答',
            },
            resolvedContext: {
                isFollowUp: false,
                topic: '问答',
                rewrite: '',
            },
        };
        const deltas: string[] = [];

        const result = await brain.processCommandDetailed(
            '介绍一下今天安排',
            '主人',
            undefined,
            'zh',
            undefined,
            undefined,
            {
                analyzeCommand: async () => intention,
                memory: {
                    getRecentConversationMessages: () => [],
                    getContextMemories: () => [],
                },
                streamText: async () => ({
                    textStream: (async function* () {
                        yield '今天';
                        yield '可以先';
                        yield '处理日程。';
                    })(),
                } as any),
                onTextDelta: (delta) => {
                    deltas.push(delta);
                },
            },
        );

        expect(deltas).toEqual(['今天', '可以先', '处理日程。']);
        expect(result.text).toBe('今天可以先处理日程。');
    });

    test('should not inject pending memory candidates as approved memories', async () => {
        const brain = new HomeBrain();
        const intention: IntentionAnalysis = {
            intent: 'qa',
            dialogueAct: 'new_request',
            shouldRespond: true,
            shouldEndSession: false,
            visualUnderstanding: {
                required: false,
                reason: '当前请求不需要视觉理解',
            },
            memoryRetrieval: {
                enabled: true,
                mode: 'semantic',
                query: 'concise answers',
                topics: ['助手互动偏好'],
                timeScope: 'unspecified',
                confidence: 0.9,
                reason: '用户问题可能受历史偏好影响',
            },
            resolvedContext: {
                isFollowUp: false,
                topic: '助手互动偏好',
                rewrite: '',
            },
        };
        let generatedPrompt = '';

        await brain.processCommandDetailed(
            '回答时按我的偏好来',
            '主人',
            undefined,
            'zh',
            undefined,
            'candidate-session',
            {
                analyzeCommand: async () => intention,
                memory: {
                    getRecentConversationMessages: () => [],
                    getContextMemories: () => [],
                },
                generateText: async (options: any) => {
                    generatedPrompt = String(options.messages.at(-1)?.content ?? '');
                    return { text: '好的，我会尽量简洁。' } as any;
                },
            },
        );

        expect(generatedPrompt).toContain('"approvedMemories":[]');
        expect(generatedPrompt).not.toContain('pending');
    });

    test('should label recent recall memories as long-term context', async () => {
        const brain = new HomeBrain();
        const intention: IntentionAnalysis = {
            intent: 'memory_recall',
            dialogueAct: 'new_request',
            shouldRespond: true,
            shouldEndSession: false,
            visualUnderstanding: {
                required: false,
                reason: '当前请求不需要视觉理解',
            },
            memoryRetrieval: {
                enabled: true,
                mode: 'recent_recall',
                query: '我们最近聊过什么',
                topics: ['最近记忆回顾'],
                timeScope: 'recent',
                confidence: 0.9,
                reason: '用户询问历史聊天主题',
            },
            resolvedContext: {
                isFollowUp: false,
                topic: '最近记忆回顾',
                rewrite: '',
            },
        };
        let generatedPrompt = '';

        await brain.processCommandDetailed(
            '我们最近聊过什么',
            '主人',
            undefined,
            'zh',
            undefined,
            'new-wake-session',
            {
                analyzeCommand: async () => intention,
                memory: {
                    getRecentConversationMessages: () => [],
                    getContextMemories: () => [{
                        id: 'memory-1',
                        sourceConversationId: 'source-1',
                        content: '用户最近连续询问了辣椒炒肉和番茄炒蛋的做法。',
                        baseScore: 4,
                        hitCount: 0,
                        createdAt: Date.now(),
                        lastAccessedAt: Date.now(),
                        status: 'warm',
                        topic: '家常菜做法',
                        userState: '',
                        behaviorSignal: '',
                        interactionResult: '',
                        location: 'unknown',
                        timeBucket: 'evening',
                        dayType: 'weekday',
                        impressions: 0,
                        positiveFeedbackCount: 0,
                        negativeFeedbackCount: 0,
                        ignoredFeedbackCount: 0,
                    }],
                },
                generateText: async (options: any) => {
                    generatedPrompt = String(options.messages.at(-1)?.content ?? '');
                    return { text: '最近聊过家常菜做法。' } as any;
                },
            },
        );

        expect(generatedPrompt).toContain('"mode":"recent_recall"');
        expect(generatedPrompt).toContain('"resultCount":1');
        expect(generatedPrompt).toContain('latest approved long-term memories');
        expect(generatedPrompt).toContain('辣椒炒肉和番茄炒蛋');
    });

    test('should inject ambient memories separately from semantic retrieval', async () => {
        const brain = new HomeBrain();
        let semanticFetches = 0;
        let ambientFetches = 0;
        let generatedPrompt = '';

        await brain.processCommandDetailed(
            '放个歌',
            '主人',
            undefined,
            'zh',
            undefined,
            'ambient-session',
            {
                analyzeCommand: async () => ({
                    routing: {
                        action: 'direct_answer',
                        confidence: 0.9,
                        reason: '普通直接回答',
                    },
                    contextResolution: {
                        isFollowUp: false,
                        topic: '',
                        responseRewrite: '放个歌',
                        memoryQueryRewrite: '',
                        currentSessionSufficient: true,
                    },
                    dataPlan: {
                        memory: {
                            needed: false,
                            mode: 'none',
                            query: '',
                            topics: [],
                            canFetchInParallel: true,
                            reason: '',
                            confidence: 0.5,
                        },
                        vision: { needed: false, canFetchInParallel: true, reason: '' },
                        deviceState: { needed: false, targets: [], reason: '' },
                        safety: { riskLevel: 'none', requiresIdentity: false, requiresConfirmation: false, reason: '' },
                    },
                    responsePlan: {
                        style: 'brief_answer',
                        clarificationQuestion: '',
                    },
                    intent: 'qa',
                    dialogueAct: 'new_request',
                    shouldRespond: true,
                    shouldEndSession: false,
                    visualUnderstanding: {
                        required: false,
                        reason: '不需要视觉',
                    },
                    memoryRetrieval: {
                        enabled: false,
                        mode: 'none',
                        query: '',
                        topics: [],
                        timeScope: 'unspecified',
                        confidence: 0.5,
                        reason: '',
                    },
                    resolvedContext: {
                        isFollowUp: false,
                        topic: '',
                        rewrite: '放个歌',
                    },
                }),
                memory: {
                    getRecentConversationMessages: () => [],
                    getContextMemories: () => {
                        semanticFetches += 1;
                        return [];
                    },
                    getAmbientMemories: () => {
                        ambientFetches += 1;
                        return [{
                            id: 'ambient-1',
                            sourceConversationId: 'ambient-source',
                            content: '用户喜欢被称呼为主人，回答要简短。',
                            baseScore: 5,
                            hitCount: 0,
                            createdAt: Date.now(),
                            lastAccessedAt: Date.now(),
                            status: 'warm',
                            topic: 'assistant style',
                            userState: '喜欢被称呼为主人',
                            behaviorSignal: '全局称呼偏好',
                            interactionResult: '',
                            location: 'unknown',
                            timeBucket: 'evening',
                            dayType: 'weekday',
                            impressions: 0,
                            positiveFeedbackCount: 0,
                            negativeFeedbackCount: 0,
                            ignoredFeedbackCount: 0,
                        }];
                    },
                },
                generateText: async (options: any) => {
                    generatedPrompt = String(options.messages.at(-1)?.content ?? '');
                    return { text: '好的。' } as any;
                },
            },
        );

        expect(semanticFetches).toBe(0);
        expect(ambientFetches).toBe(1);
        expect(generatedPrompt).toContain('"ambientMemories"');
        expect(generatedPrompt).toContain('用户喜欢被称呼为主人');
    });

    test('should fetch layered memory and vision context in one response path', async () => {
        const brain = new HomeBrain();
        const intention: IntentionAnalysis = {
            routing: {
                action: 'answer_after_context',
                confidence: 0.95,
                reason: '需要记忆和当前画面后回答',
            },
            contextResolution: {
                isFollowUp: false,
                topic: '厨房安全和用户偏好',
                responseRewrite: '根据用户偏好和当前画面判断厨房情况',
                memoryQueryRewrite: '厨房 安全 用户偏好',
                currentSessionSufficient: false,
            },
            dataPlan: {
                memory: {
                    needed: true,
                    mode: 'semantic',
                    query: '厨房 安全 用户偏好',
                    topics: ['厨房安全', '用户偏好'],
                    canFetchInParallel: true,
                    reason: '用户偏好会影响回答',
                    confidence: 0.9,
                },
                vision: {
                    needed: true,
                    canFetchInParallel: true,
                    reason: '需要看当前厨房画面',
                },
                deviceState: {
                    needed: false,
                    targets: [],
                    reason: '',
                },
                safety: {
                    riskLevel: 'device_risk',
                    requiresIdentity: false,
                    requiresConfirmation: false,
                    reason: '厨房场景可能涉及安全',
                },
            },
            responsePlan: {
                style: 'brief_answer',
                clarificationQuestion: '',
            },
            intent: 'visual',
            dialogueAct: 'new_request',
            shouldRespond: true,
            shouldEndSession: false,
            visualUnderstanding: {
                required: true,
                reason: '需要查看当前厨房画面',
            },
            memoryRetrieval: {
                enabled: true,
                mode: 'semantic',
                query: '厨房 安全 用户偏好',
                topics: ['厨房安全', '用户偏好'],
                timeScope: 'unspecified',
                confidence: 0.9,
                reason: '用户偏好会影响回答',
            },
            resolvedContext: {
                isFollowUp: false,
                topic: '厨房安全和用户偏好',
                rewrite: '根据用户偏好和当前画面判断厨房情况',
            },
        };
        let memoryQuery = '';
        let generatedPrompt = '';
        const calls: any[] = [];
        const pipelineId = 'pipe-layered-memory-hit-list';

        await brain.processCommandDetailed(
            '帮我看看厨房现在要注意什么',
            '主人',
            undefined,
            'zh',
            Buffer.from('fake-image'),
            'layered-session',
            {
                analyzeCommand: async () => intention,
                memory: {
                    getRecentConversationMessages: () => [],
                    getContextMemories: (options: any) => {
                        memoryQuery = options.query;
                        return [{
                            id: 'memory-1',
                            sourceConversationId: 'source-1',
                            content: '用户偏好厨房提醒要简短直接。',
                            baseScore: 5,
                            hitCount: 0,
                            createdAt: Date.now(),
                            lastAccessedAt: Date.now(),
                            status: 'warm',
                            topic: '厨房提醒偏好',
                            userState: '',
                            behaviorSignal: '偏好简短直接',
                            interactionResult: '',
                            location: 'kitchen',
                            timeBucket: 'evening',
                            dayType: 'weekday',
                            impressions: 0,
                            positiveFeedbackCount: 0,
                            negativeFeedbackCount: 0,
                            ignoredFeedbackCount: 0,
                        }];
                    },
                    getAmbientMemories: () => [{
                        id: 'ambient-1',
                        sourceConversationId: 'source-ambient',
                        content: '用户偏好直接称呼为主人。',
                        baseScore: 5,
                        hitCount: 0,
                        createdAt: Date.now(),
                        lastAccessedAt: Date.now(),
                        status: 'warm',
                        topic: '称呼偏好',
                        userState: '',
                        behaviorSignal: 'global preference',
                        interactionResult: '',
                        location: 'unknown',
                        timeBucket: 'evening',
                        dayType: 'weekday',
                        impressions: 0,
                        positiveFeedbackCount: 0,
                        negativeFeedbackCount: 0,
                        ignoredFeedbackCount: 0,
                    }],
                },
                pipelineId,
                generateText: async (options: any) => {
                    calls.push(options);
                    if (calls.length === 1) {
                        return { text: '画面里台面有锅具。' } as any;
                    }
                    generatedPrompt = String(options.messages.at(-1)?.content ?? '');
                    return { text: '台面有锅具，注意关火并保持通道清爽。' } as any;
                },
            },
        );

        expect(memoryQuery).toBe('厨房 安全 用户偏好');
        expect(generatedPrompt).toContain('用户偏好厨房提醒要简短直接');
        expect(generatedPrompt).toContain('用户偏好直接称呼为主人');
        expect(generatedPrompt).toContain('画面里台面有锅具');
        const detail = pipelineLogs.getPipelineDetail(pipelineId);
        const hitList = detail?.events.find(event => event.title === 'memory.hit_list');
        const metadata = hitList?.metadata as { memories?: Array<{ id: string }>; ambientMemories?: Array<{ id: string }> } | undefined;
        expect(hitList?.stage).toBe('memory');
        expect(metadata?.memories?.map(item => item.id)).toEqual(['memory-1']);
        expect(metadata?.ambientMemories?.map(item => item.id)).toEqual(['ambient-1']);
        pipelineLogs.removePipeline(pipelineId);
    });

    test('should use intention visual decision instead of keyword matching', async () => {
        const brain = new HomeBrain();
        const intention: IntentionAnalysis = {
            intent: 'visual',
            dialogueAct: 'new_request',
            shouldRespond: true,
            shouldEndSession: false,
            visualUnderstanding: {
                required: true,
                reason: '用户需要识别当前画面里的可见状态',
            },
            memoryRetrieval: {
                enabled: false,
                mode: 'none',
                query: '',
                topics: ['视觉理解'],
                timeScope: 'unspecified',
                confidence: 0.9,
                reason: '视觉问题不需要长期记忆',
            },
            resolvedContext: {
                isFollowUp: false,
                topic: '视觉理解',
                rewrite: '识别当前画面里的可见状态',
            },
        };
        const calls: any[] = [];

        await brain.processCommandDetailed(
            '这边情况怎么样',
            '主人',
            undefined,
            'zh',
            Buffer.from('fake-image'),
            'vision-session',
            {
                analyzeCommand: async () => intention,
                memory: {
                    getRecentConversationMessages: () => [],
                    getContextMemories: () => [],
                },
                generateText: async (options: any) => {
                    calls.push(options);
                    return { text: calls.length === 1 ? '画面里有一杯水。' : '我看到画面里有一杯水。' } as any;
                },
            },
        );

        expect(calls).toHaveLength(2);
        expect(calls[0].prompt).toContain('识别当前画面里的可见状态');
        expect(calls[0].image).toBeInstanceOf(Buffer);
        expect(String(calls[1].messages.at(-1).content)).toContain('画面里有一杯水');
    });

    test('should prepare valid jpeg before sending image to vision model', async () => {
        const brain = new HomeBrain();
        const intention: IntentionAnalysis = {
            intent: 'visual',
            dialogueAct: 'new_request',
            shouldRespond: true,
            shouldEndSession: false,
            visualUnderstanding: {
                required: true,
                reason: '用户需要识别当前画面',
            },
            memoryRetrieval: {
                enabled: false,
                mode: 'none',
                query: '',
                topics: ['视觉理解'],
                timeScope: 'unspecified',
                confidence: 0.9,
                reason: '视觉问题不需要长期记忆',
            },
            resolvedContext: {
                isFollowUp: false,
                topic: '视觉理解',
                rewrite: '',
            },
        };
        const sourceImage = readFileSync(join(process.cwd(), 'src/server/test/assets/test_face.png'));
        const calls: any[] = [];

        await brain.processCommandDetailed(
            '看看现在画面',
            '主人',
            undefined,
            'zh',
            sourceImage,
            undefined,
            {
                analyzeCommand: async () => intention,
                memory: {
                    getRecentConversationMessages: () => [],
                    getContextMemories: () => [],
                },
                generateText: async (options: any) => {
                    calls.push(options);
                    return { text: calls.length === 1 ? '画面正常。' : '看起来画面正常。' } as any;
                },
            },
        );

        expect(calls[0].image).toBeInstanceOf(Buffer);
        expect(calls[0].image.length).toBeGreaterThan(0);
        expect(calls[0].image[0]).toBe(0xff);
        expect(calls[0].image[1]).toBe(0xd8);
    });
});
