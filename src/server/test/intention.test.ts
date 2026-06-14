import { describe, expect, test } from 'bun:test';
import { analyzeCommand, parseIntentionAnalysis } from '@modules/intention';
import type { ConversationMessage } from '@modules/memory';
import { pipelineLogs } from '@server/services/PipelineLogService';

function mockGenerateText(text: string) {
    return async () => ({ text }) as any;
}

function coreDecision(overrides: Record<string, unknown> = {}) {
    const { resolvedContext: resolvedContextOverride, ...rest } = overrides;
    const resolvedContext = {
        isFollowUp: false,
        topic: '',
        rewriteQuery: 'default query',
        ...((resolvedContextOverride as Record<string, unknown> | undefined) ?? {}),
    };
    return {
        traceId: 'trace-test',
        intent: 'qa',
        dialogueAct: 'new_request',
        routingAction: 'direct_answer',
        requiresLongTermMemory: false,
        requiresToolsOrMCP: false,
        ...rest,
        resolvedContext,
    };
}

describe('Intention analysis', () => {
    test('records pre-router rule checks and timings on the pipeline for matched, missed, and skipped outcomes', async () => {
        const cases = [
            {
                pipelineId: 'pipe-pre-router-trace-matched',
                command: '关灯',
                expectedCalls: 0,
                expectedOutcome: 'matched',
                expectedRule: 'safe_device_control_placeholder',
                expectedModelSkipped: true,
                expectedNormalizedCommand: '关灯',
            },
            {
                pipelineId: 'pipe-pre-router-trace-missed',
                command: '请帮我关灯。',
                expectedCalls: 1,
                expectedOutcome: 'missed',
                expectedRule: undefined,
                expectedModelSkipped: false,
                expectedNormalizedCommand: '请帮我关灯',
            },
            {
                pipelineId: 'pipe-pre-router-trace-skipped',
                command: '再见，然后帮我总结一下',
                expectedCalls: 1,
                expectedOutcome: 'skipped_to_model',
                expectedRule: 'multi_intent_detected',
                expectedModelSkipped: false,
                expectedNormalizedCommand: '再见然后帮我总结一下',
            },
        ] as const;

        for (const item of cases) {
            pipelineLogs.removePipeline(item.pipelineId);

            try {
                let callCount = 0;
                await analyzeCommand(
                    {
                        userCommand: item.command,
                        traceId: `trace-${item.expectedOutcome}`,
                        pipelineId: item.pipelineId,
                        conversationId: `conversation-${item.expectedOutcome}`,
                    },
                    {
                        generateText: async () => {
                            callCount += 1;
                            return {
                                text: JSON.stringify(coreDecision({
                                    resolvedContext: { rewriteQuery: item.command },
                                })),
                            } as any;
                        },
                    },
                );

                const event = pipelineLogs
                    .listEvents({ pipelineId: item.pipelineId, stage: 'intent', limit: 20 })
                    .find(candidate => candidate.title === 'pre_router.trace');
                const metadata = event?.metadata && typeof event.metadata === 'object'
                    ? event.metadata as Record<string, unknown>
                    : {};
                const checks = Array.isArray(metadata.checks)
                    ? metadata.checks as Array<Record<string, unknown>>
                    : [];

                expect(callCount).toBe(item.expectedCalls);
                expect(event?.eventType).toBe('decision');
                expect(event?.message).toBe(
                    item.expectedRule ? `${item.expectedOutcome}:${item.expectedRule}` : item.expectedOutcome,
                );
                expect(event?.timings?.some(timing => timing.key === 'pre_router_total')).toBe(true);
                expect(event?.timings?.length).toBeGreaterThan(1);
                expect(metadata.outcome).toBe(item.expectedOutcome);
                if (item.expectedRule) {
                    expect(metadata.matchedRule).toBe(item.expectedRule);
                } else {
                    expect(Object.hasOwn(metadata, 'matchedRule')).toBe(false);
                }
                expect(metadata.modelSkipped).toBe(item.expectedModelSkipped);
                expect(metadata.normalizedCommand).toBe(item.expectedNormalizedCommand);
                expect(checks.length).toBeGreaterThan(0);
                expect(checks.some(check => check.rule === (item.expectedRule ?? 'strict_ordinary_qa'))).toBe(true);
            } finally {
                pipelineLogs.removePipeline(item.pipelineId);
            }
        }
    });

    test('pre-router normalizes ASR filler for session and safe device commands without calling model', async () => {
        const cases = [
            { command: '呃 拜拜', intent: 'conversation_end', action: 'end_session' },
            { command: '白白', intent: 'conversation_end', action: 'end_session' },
            { command: '那个 开灯', intent: 'device_control', action: 'execute_device' },
            { command: '啊不用了', intent: 'conversation_end', action: 'end_session' },
        ] as const;

        for (const item of cases) {
            let callCount = 0;
            const result = await analyzeCommand(
                { userCommand: item.command },
                {
                    generateText: async () => {
                        callCount += 1;
                        return { text: JSON.stringify(coreDecision()) } as any;
                    },
                },
            );

            expect(callCount).toBe(0);
            expect(result.intent).toBe(item.intent);
            expect(result.routing?.action).toBe(item.action);
        }
    });

    test('pre-router sends multi-intent commands to the model router', async () => {
        const cases = [
            '帮我开灯，顺便查明天天气',
            '再见，然后帮我总结一下',
        ];

        for (const command of cases) {
            let callCount = 0;
            const result = await analyzeCommand(
                { userCommand: command },
                {
                    generateText: async () => {
                        callCount += 1;
                        return { text: JSON.stringify(coreDecision({ resolvedContext: { rewriteQuery: command } })) } as any;
                    },
                },
            );

            expect(callCount).toBe(1);
            expect(result.intent).toBe('qa');
            expect(result.resolvedContext.rewrite).toBe(command);
        }
    });

    test('pre-router refuses to classify blacklisted ordinary QA and lets model decide when context is ambiguous', async () => {
        const cases = [
            '怎么门口的灯还亮着',
            '这个怎么弄',
        ];

        for (const command of cases) {
            let callCount = 0;
            const result = await analyzeCommand(
                { userCommand: command },
                {
                    generateText: async () => {
                        callCount += 1;
                        return { text: JSON.stringify(coreDecision({ resolvedContext: { rewriteQuery: command } })) } as any;
                    },
                },
            );

            expect(callCount).toBe(1);
            expect(result.routing?.action).toBe('direct_answer');
        }

        let visualCalls = 0;
        const visual = await analyzeCommand(
            { userCommand: '如何评价我今天穿的衣服' },
            {
                generateText: async () => {
                    visualCalls += 1;
                    return { text: JSON.stringify(coreDecision()) } as any;
                },
            },
        );

        expect(visualCalls).toBe(0);
        expect(visual.intent).toBe('visual');
        expect(visual.visualUnderstanding.required).toBe(true);
    });

    test('pre-router handles obvious context routes conservatively', async () => {
        const memory = await analyzeCommand(
            { userCommand: '我刚才说了什么' },
            { generateText: mockGenerateText(JSON.stringify(coreDecision())) },
        );
        const visual = await analyzeCommand(
            { userCommand: '看看我穿的衣服怎么样' },
            { generateText: mockGenerateText(JSON.stringify(coreDecision())) },
        );
        let ambiguousCalls = 0;
        const ambiguous = await analyzeCommand(
            { userCommand: '这是什么' },
            {
                generateText: async () => {
                    ambiguousCalls += 1;
                    return {
                        text: JSON.stringify(coreDecision({
                            intent: 'visual',
                            routingAction: 'answer_after_context',
                            resolvedContext: {
                                topic: '视觉理解',
                                rewriteQuery: '识别当前画面里的对象',
                            },
                            requiresToolsOrMCP: true,
                        })),
                    } as any;
                },
            },
        );

        expect(memory.intent).toBe('memory_recall');
        expect(memory.memoryRetrieval.enabled).toBe(true);
        expect(memory.routingDiagnostics?.scoring?.visibility).toBe('eligible');
        expect(memory.routingDiagnostics?.scoring?.components.freshness).toBe(0.5);
        expect(memory.routingDiagnostics?.scoring?.finalScore).toBeGreaterThan(0);
        expect(visual.intent).toBe('visual');
        expect(visual.visualUnderstanding.required).toBe(true);
        expect(ambiguousCalls).toBe(1);
        expect(ambiguous.intent).toBe('visual');
    });

    test('pre-router direct-answers local utility time but leaves weather to the model', async () => {
        let timeCalls = 0;
        const time = await analyzeCommand(
            { userCommand: '现在几点' },
            {
                generateText: async () => {
                    timeCalls += 1;
                    return { text: JSON.stringify(coreDecision()) } as any;
                },
            },
        );
        let weatherCalls = 0;
        const weather = await analyzeCommand(
            { userCommand: '明天天气怎么样' },
            {
                generateText: async () => {
                    weatherCalls += 1;
                    return { text: JSON.stringify(coreDecision({ resolvedContext: { rewriteQuery: '明天天气怎么样' } })) } as any;
                },
            },
        );

        expect(timeCalls).toBe(0);
        expect(time.intent).toBe('qa');
        expect(time.routing?.action).toBe('direct_answer');
        expect(time.resolvedContext.topic).toBe('本地时间日期');
        expect(weatherCalls).toBe(1);
        expect(weather.resolvedContext.rewrite).toBe('明天天气怎么样');
    });

    test('pre-router guards high-risk system, privacy, and security commands', async () => {
        const cases = [
            '清空记忆',
            '打开摄像头',
            '重启服务',
            '关闭防火墙',
        ];

        for (const command of cases) {
            let callCount = 0;
            const result = await analyzeCommand(
                { userCommand: command },
                {
                    generateText: async () => {
                        callCount += 1;
                        return { text: JSON.stringify(coreDecision()) } as any;
                    },
                },
            );

            expect(callCount).toBe(0);
            expect(result.routing?.action).toBe('ask_clarification');
            expect(result.responsePlan?.style).toBe('clarification_question');
            expect(result.dataPlan?.safety.requiresConfirmation).toBe(true);
            expect(result.dataPlan?.safety.riskLevel).not.toBe('none');
            expect(result.routingDiagnostics?.source).toBe('pre-router');
            expect(result.routingDiagnostics?.preRouterLayer).toBe('P2');
            expect(result.routingDiagnostics?.preRouterRule).toBe('high_risk_guard');
            expect(result.routingDiagnostics?.modelSkipped).toBe(true);
        }
    });

    test('parses core direct answer without memory retrieval', async () => {
        const result = await analyzeCommand(
            { userCommand: '今天适合做什么晚饭' },
            { generateText: mockGenerateText(JSON.stringify(coreDecision())) },
        );

        expect(result.routing?.action).toBe('direct_answer');
        expect(result.dataPlan?.memory.needed).toBe(false);
        expect(result.memoryRetrieval.enabled).toBe(false);
        expect(result.resolvedContext.rewrite).toBe('default query');
        expect(result.routingDiagnostics).toEqual({
            source: 'qwen-router',
            modelSkipped: false,
        });
    });

    test('falls back to direct answer without long-term memory when router fails for ordinary QA', async () => {
        const result = await analyzeCommand(
            { userCommand: '红烧牛肉怎么做？' },
            {
                generateText: async () => {
                    throw new Error('router unavailable');
                },
            },
        );

        expect(result.intent).toBe('qa');
        expect(result.routing?.action).toBe('direct_answer');
        expect(result.requiresLongTermMemory).toBe(false);
        expect(result.dataPlan?.memory.needed).toBe(false);
        expect(result.memoryRetrieval.enabled).toBe(false);
        expect(result.resolvedContext.rewrite).toBe('红烧牛肉怎么做？');
    });

    test('parses core memory recall into recent recall retrieval', async () => {
        const result = await analyzeCommand(
            { userCommand: '总结一下最近聊过的装修想法' },
            {
                generateText: mockGenerateText(JSON.stringify(coreDecision({
                    intent: 'memory_recall',
                    routingAction: 'answer_after_context',
                    resolvedContext: {
                        topic: '装修/家居规划',
                        rewriteQuery: '最近聊过的装修想法',
                    },
                    requiresLongTermMemory: true,
                }))),
            },
        );

        expect(result.intent).toBe('memory_recall');
        expect(result.routing?.action).toBe('answer_after_context');
        expect(result.dataPlan?.memory.needed).toBe(true);
        expect(result.memoryRetrieval.mode).toBe('recent_recall');
        expect(result.memoryRetrieval.query).toBe('最近聊过的装修想法');
    });

    test('parses core clarification route without memory retrieval', async () => {
        const result = await analyzeCommand(
            { userCommand: '关掉那个' },
            {
                generateText: mockGenerateText(JSON.stringify(coreDecision({
                    intent: 'device_control',
                    routingAction: 'ask_clarification',
                    resolvedContext: {
                        topic: '智能家居控制',
                        rewriteQuery: '询问需要关闭哪个设备',
                    },
                    requiresLongTermMemory: false,
                    requiresToolsOrMCP: true,
                }))),
            },
        );

        expect(result.routing?.action).toBe('ask_clarification');
        expect(result.responsePlan?.style).toBe('clarification_question');
        expect(result.memoryRetrieval.enabled).toBe(false);
    });

    test('uses core routing topic for semantic memory context', async () => {
        const result = await analyzeCommand(
            { userCommand: '如何做番茄炒蛋' },
            {
                generateText: mockGenerateText(JSON.stringify(coreDecision({
                    routingAction: 'answer_after_context',
                    resolvedContext: {
                        topic: '烹饪/家常菜',
                        rewriteQuery: '家常菜 烹饪 鸡蛋和番茄菜品 做法',
                    },
                    requiresLongTermMemory: true,
                }))),
            },
        );

        expect(result.intent).toBe('qa');
        expect(result.memoryRetrieval.mode).toBe('semantic');
        expect(result.memoryRetrieval.topics).toEqual(['烹饪/家常菜']);
        expect(result.resolvedContext.topic).toBe('烹饪/家常菜');
    });

    test('deterministically corrects memory recall that disables memory', async () => {
        const result = await analyzeCommand(
            { userCommand: '我们最近有聊过什么话题吗' },
            {
                generateText: mockGenerateText(JSON.stringify(coreDecision({
                    intent: 'memory_recall',
                    routingAction: 'direct_answer',
                    resolvedContext: {
                        topic: '最近记忆回顾',
                        rewriteQuery: '',
                    },
                    requiresLongTermMemory: false,
                }))),
            },
        );

        expect(result.intent).toBe('memory_recall');
        expect(result.memoryRetrieval.enabled).toBe(true);
        expect(result.memoryRetrieval.mode).toBe('recent_recall');
        expect(result.memoryRetrieval.query).toBe('我们最近有聊过什么话题吗');
    });

    test('uses core output to rewrite short follow-ups with context', async () => {
        const recentConversationMessages: ConversationMessage[] = [
            {
                role: 'user',
                content: '请告诉我番茄炒蛋怎么做',
                createdAt: '2026-05-21T01:00:00.000Z',
            },
        ];

        const result = await analyzeCommand(
            { userCommand: '有什么需要注意的吗', recentConversationMessages },
            {
                generateText: mockGenerateText(JSON.stringify(coreDecision({
                    intent: 'follow_up',
                    dialogueAct: 'follow_up',
                    routingAction: 'answer_after_context',
                    resolvedContext: {
                        isFollowUp: true,
                        topic: '番茄炒蛋烹饪注意事项',
                        rewriteQuery: '番茄炒蛋 烹饪 注意事项 火候 调味',
                    },
                    requiresLongTermMemory: true,
                }))),
            },
        );

        expect(result.intent).toBe('follow_up');
        expect(result.memoryRetrieval.mode).toBe('semantic');
        expect(result.memoryRetrieval.query).toContain('注意事项');
        expect(result.resolvedContext.isFollowUp).toBe(true);
    });

    test('uses core output to avoid memory retrieval for device control', async () => {
        const result = await analyzeCommand(
            { userCommand: '开灯' },
            {
                generateText: mockGenerateText(JSON.stringify(coreDecision({
                    intent: 'device_control',
                    routingAction: 'execute_device',
                    resolvedContext: {
                        topic: '智能家居照明',
                        rewriteQuery: '打开灯',
                    },
                    requiresLongTermMemory: false,
                    requiresToolsOrMCP: true,
                }))),
            },
        );

        expect(result.intent).toBe('device_control');
        expect(result.memoryRetrieval.mode).toBe('none');
        expect(result.memoryRetrieval.enabled).toBe(false);
        expect(result.dataPlan?.deviceState.needed).toBe(true);
    });

    test('handles proposal answers as current-session follow-ups without long-term memory', async () => {
        const recentConversationMessages: ConversationMessage[] = [
            {
                role: 'agent',
                content: '需要我再提供一些菜谱吗？',
                createdAt: '2026-05-21T01:00:00.000Z',
            },
        ];
        let callCount = 0;

        const result = await analyzeCommand(
            { userCommand: '可以呀', recentConversationMessages },
            {
                generateText: async () => {
                    callCount += 1;
                    return {
                        text: JSON.stringify(coreDecision({
                            intent: 'follow_up',
                            dialogueAct: 'answer_to_assistant',
                            routingAction: 'direct_answer',
                            resolvedContext: {
                                isFollowUp: true,
                                topic: '烹饪/家常菜',
                                rewriteQuery: '请继续提供新的家常菜菜谱',
                            },
                            requiresLongTermMemory: false,
                        })),
                    } as any;
                },
            },
        );

        expect(callCount).toBe(1);
        expect(result.intent).toBe('follow_up');
        expect(result.dialogueAct).toBe('answer_to_assistant');
        expect(result.memoryRetrieval.enabled).toBe(false);
        expect(result.resolvedContext.rewrite).toContain('菜谱');
    });

    test('can ignore non-actionable input without memory retrieval', async () => {
        const result = await analyzeCommand(
            { userCommand: '嗯嗯' },
            {
                generateText: mockGenerateText(JSON.stringify(coreDecision({
                    intent: 'non_actionable',
                    dialogueAct: 'noise',
                    routingAction: 'ignore',
                    resolvedContext: {
                        topic: '',
                        rewriteQuery: '',
                    },
                    requiresLongTermMemory: false,
                }))),
            },
        );

        expect(result.intent).toBe('non_actionable');
        expect(result.shouldRespond).toBe(false);
        expect(result.memoryRetrieval.enabled).toBe(false);
    });

    test('falls back to semantic retrieval on invalid json', () => {
        const result = parseIntentionAnalysis('not json', '番茄炒蛋怎么做');

        expect(result.intent).toBe('qa');
        expect(result.visualUnderstanding.required).toBe(false);
        expect(result.memoryRetrieval.mode).toBe('semantic');
        expect(result.memoryRetrieval.query).toBe('番茄炒蛋怎么做');
        expect(result.memoryRetrieval.topics).toEqual([]);
    });

    test('preserves core visual routing decision', async () => {
        const result = await analyzeCommand(
            { userCommand: '这边情况怎么样' },
            {
                generateText: mockGenerateText(JSON.stringify(coreDecision({
                    intent: 'visual',
                    routingAction: 'answer_after_context',
                    resolvedContext: {
                        topic: '视觉理解',
                        rewriteQuery: '判断当前画面里的现场状态',
                    },
                    requiresToolsOrMCP: true,
                }))),
            },
        );

        expect(result.intent).toBe('visual');
        expect(result.visualUnderstanding.required).toBe(true);
        expect(result.memoryRetrieval.enabled).toBe(false);
    });

    test('repairs invalid core output before falling back', async () => {
        const calls: string[] = [];
        const result = await analyzeCommand(
            { userCommand: '帮我整理装修方案' },
            {
                generateText: async ({ messages }: any) => {
                    calls.push(messages[messages.length - 1].content);
                    if (calls.length === 1) {
                        return { text: JSON.stringify({ intent: 'memory_recall' }) } as any;
                    }
                    return {
                        text: JSON.stringify(coreDecision({
                            intent: 'memory_recall',
                            routingAction: 'answer_after_context',
                            resolvedContext: {
                                topic: '装修/家居规划',
                                rewriteQuery: '最近聊过的装修想法',
                            },
                            requiresLongTermMemory: true,
                        })),
                    } as any;
                },
            },
        );

        expect(calls).toHaveLength(2);
        expect(calls[1]).toContain('previous routing JSON failed validation');
        expect(result.intent).toBe('memory_recall');
        expect(result.memoryRetrieval.query).toBe('最近聊过的装修想法');
    });

    test('uses separate repair generator after invalid core routing output', async () => {
        const routingCalls: string[] = [];
        const repairCalls: string[] = [];
        const result = await analyzeCommand(
            { userCommand: '帮我整理装修方案' },
            {
                generateText: async ({ messages }: any) => {
                    routingCalls.push(messages[messages.length - 1].content);
                    return { text: JSON.stringify({ intent: 'memory_recall' }) } as any;
                },
                repairGenerateText: async ({ messages }: any) => {
                    repairCalls.push(messages[messages.length - 1].content);
                    return {
                        text: JSON.stringify(coreDecision({
                            intent: 'memory_recall',
                            routingAction: 'answer_after_context',
                            resolvedContext: {
                                topic: '装修/家居规划',
                                rewriteQuery: '最近聊过的装修想法',
                            },
                            requiresLongTermMemory: true,
                        })),
                    } as any;
                },
            },
        );

        expect(routingCalls).toHaveLength(1);
        expect(repairCalls).toHaveLength(1);
        expect(repairCalls[0]).toContain('previous routing JSON failed validation');
        expect(result.intent).toBe('memory_recall');
    });

    test('can end session without memory retrieval', async () => {
        const result = await analyzeCommand(
            { userCommand: '暂时没有' },
            {
                generateText: mockGenerateText(JSON.stringify(coreDecision({
                    intent: 'conversation_end',
                    dialogueAct: 'answer_to_assistant',
                    routingAction: 'end_session',
                    resolvedContext: {
                        topic: '对话结束',
                        rewriteQuery: '',
                    },
                    requiresLongTermMemory: false,
                }))),
            },
        );

        expect(result.intent).toBe('conversation_end');
        expect(result.shouldEndSession).toBe(true);
        expect(result.memoryRetrieval.enabled).toBe(false);
    });

    test('pre-router rewrites explicit short follow-up from recent assistant context', async () => {
        const recentConversationMessages: ConversationMessage[] = [
            {
                role: 'agent',
                content: '番茄炒蛋需要先炒鸡蛋，再炒番茄，最后合炒调味。',
                createdAt: '2026-05-21T01:00:00.000Z',
            },
        ];
        let callCount = 0;

        const result = await analyzeCommand(
            {
                userCommand: '有什么需要注意的吗',
                recentConversationMessages,
            },
            {
                generateText: async () => {
                    callCount += 1;
                    return { text: JSON.stringify(coreDecision()) } as any;
                },
            },
        );

        expect(callCount).toBe(0);
        expect(result.intent).toBe('follow_up');
        expect(result.routing?.action).toBe('direct_answer');
        expect(result.memoryRetrieval.enabled).toBe(false);
        expect(result.memoryRetrieval.mode).toBe('none');
        expect(result.resolvedContext.rewrite).toContain('番茄炒蛋');
    });
});
