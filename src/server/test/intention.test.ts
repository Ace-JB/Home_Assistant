import { describe, expect, test } from 'bun:test';
import { analyzeCommand, parseIntentionAnalysis } from '@modules/intention';
import type { ConversationMessage } from '@modules/memory';

function mockGenerateText(text: string) {
    return async () => ({ text }) as any;
}

function validAnalysis(overrides: Record<string, unknown> = {}) {
    return {
        intent: 'qa',
        dialogueAct: 'new_request',
        shouldRespond: true,
        shouldEndSession: false,
        visualUnderstanding: {
            required: false,
            reason: '默认不需要视觉理解',
        },
        memoryRetrieval: {
            enabled: true,
            mode: 'semantic',
            query: 'default query',
            topics: ['默认主题'],
            timeScope: 'unspecified',
            confidence: 0.85,
            reason: '默认需要语义检索',
        },
        resolvedContext: {
            isFollowUp: false,
            topic: '默认主题',
            rewrite: 'default query',
        },
        ...overrides,
    };
}

function validLayeredAnalysis(overrides: Record<string, unknown> = {}) {
    return {
        routing: {
            action: 'direct_answer',
            confidence: 0.9,
            reason: '可以直接回答',
        },
        contextResolution: {
            isFollowUp: false,
            topic: '默认主题',
            responseRewrite: 'default query',
            memoryQueryRewrite: '',
            currentSessionSufficient: true,
        },
        dataPlan: {
            memory: {
                needed: false,
                mode: 'none',
                query: '',
                topics: ['默认主题'],
                canFetchInParallel: true,
                reason: '无需长期记忆',
                confidence: 0.9,
            },
            vision: {
                needed: false,
                canFetchInParallel: true,
                reason: '无需视觉',
            },
            deviceState: {
                needed: false,
                targets: [],
                reason: '',
            },
            safety: {
                riskLevel: 'none',
                requiresIdentity: false,
                requiresConfirmation: false,
                reason: '',
            },
        },
        responsePlan: {
            style: 'brief_answer',
            clarificationQuestion: '',
        },
        ...overrides,
    };
}

describe('Intention analysis', () => {
    test('should parse layered direct answer without memory retrieval', async () => {
        const result = await analyzeCommand(
            { userCommand: '今天适合做什么晚饭' },
            {
                generateText: mockGenerateText(JSON.stringify(validLayeredAnalysis({
                    intent: 'qa',
                    dialogueAct: 'new_request',
                }))),
            },
        );

        expect(result.routing!.action).toBe('direct_answer');
        expect(result.dataPlan!.memory.needed).toBe(false);
        expect(result.memoryRetrieval.enabled).toBe(false);
        expect(result.resolvedContext.rewrite).toBe('default query');
    });

    test('should parse layered memory recall into recent recall retrieval', async () => {
        const result = await analyzeCommand(
            { userCommand: '总结一下最近聊过的装修想法' },
            {
                generateText: mockGenerateText(JSON.stringify(validLayeredAnalysis({
                    routing: {
                        action: 'answer_after_context',
                        confidence: 0.95,
                        reason: '需要查长期记忆后回答',
                    },
                    contextResolution: {
                        isFollowUp: false,
                        topic: '装修/家居规划',
                        responseRewrite: '总结最近聊过的装修想法',
                        memoryQueryRewrite: '最近聊过的装修想法',
                        currentSessionSufficient: false,
                    },
                    dataPlan: {
                        memory: {
                            needed: true,
                            mode: 'recent_recall',
                            query: '最近聊过的装修想法',
                            topics: ['装修/家居规划'],
                            canFetchInParallel: true,
                            reason: '用户要求回顾历史记忆',
                            confidence: 0.95,
                        },
                        vision: { needed: false, canFetchInParallel: true, reason: '无需视觉' },
                        deviceState: { needed: false, targets: [], reason: '' },
                        safety: { riskLevel: 'none', requiresIdentity: false, requiresConfirmation: false, reason: '' },
                    },
                    intent: 'memory_recall',
                    dialogueAct: 'new_request',
                }))),
            },
        );

        expect(result.intent).toBe('memory_recall');
        expect(result.routing!.action).toBe('answer_after_context');
        expect(result.dataPlan!.memory.needed).toBe(true);
        expect(result.memoryRetrieval.mode).toBe('recent_recall');
        expect(result.memoryRetrieval.query).toBe('最近聊过的装修想法');
    });

    test('should parse layered clarification route without memory retrieval', async () => {
        const result = await analyzeCommand(
            { userCommand: '关掉那个' },
            {
                generateText: mockGenerateText(JSON.stringify(validLayeredAnalysis({
                    routing: {
                        action: 'ask_clarification',
                        confidence: 0.9,
                        reason: '缺少设备和房间',
                    },
                    contextResolution: {
                        isFollowUp: false,
                        topic: '智能家居控制',
                        responseRewrite: '询问需要关闭哪个设备',
                        memoryQueryRewrite: '',
                        currentSessionSufficient: true,
                    },
                    responsePlan: {
                        style: 'clarification_question',
                        clarificationQuestion: '请问要关闭哪个设备？',
                    },
                    intent: 'device_control',
                    dialogueAct: 'new_request',
                }))),
            },
        );

        expect(result.routing!.action).toBe('ask_clarification');
        expect(result.responsePlan!.style).toBe('clarification_question');
        expect(result.memoryRetrieval.enabled).toBe(false);
    });

    test('should use model output for abstract cooking topic instead of keyword rules', async () => {
        const result = await analyzeCommand(
            { userCommand: '如何做番茄炒蛋' },
            {
                generateText: mockGenerateText(JSON.stringify({
                    intent: 'qa',
                    dialogueAct: 'new_request',
                    shouldRespond: true,
                    shouldEndSession: false,
                    memoryRetrieval: {
                        enabled: true,
                        mode: 'semantic',
                        query: '家常菜 烹饪 鸡蛋和番茄菜品 做法',
                        topics: ['烹饪', '家常菜'],
                        timeScope: 'unspecified',
                        confidence: 0.92,
                        reason: '用户询问烹饪做法，可能需要相关偏好或历史做菜话题',
                    },
                    resolvedContext: {
                        isFollowUp: false,
                        topic: '烹饪/家常菜',
                        rewrite: '如何制作番茄炒蛋',
                    },
                })),
            },
        );

        expect(result.intent).toBe('qa');
        expect(result.memoryRetrieval.mode).toBe('semantic');
        expect(result.memoryRetrieval.topics).toEqual(['烹饪', '家常菜']);
        expect(result.resolvedContext.topic).toBe('烹饪/家常菜');
    });

    test('should use model output for recent memory recall', async () => {
        const result = await analyzeCommand(
            { userCommand: '我们最近有聊过什么吗' },
            {
                generateText: mockGenerateText(JSON.stringify({
                    intent: 'memory_recall',
                    dialogueAct: 'new_request',
                    shouldRespond: true,
                    shouldEndSession: false,
                    memoryRetrieval: {
                        enabled: true,
                        mode: 'recent_recall',
                        query: '最近对话主题回顾',
                        topics: ['最近记忆回顾'],
                        timeScope: 'recent',
                        confidence: 0.94,
                        reason: '用户明确要求回顾最近聊过的话题',
                    },
                    resolvedContext: {
                        isFollowUp: false,
                        topic: '最近记忆回顾',
                        rewrite: '回顾最近聊过的长期记忆主题',
                    },
                })),
            },
        );

        expect(result.intent).toBe('memory_recall');
        expect(result.memoryRetrieval.mode).toBe('recent_recall');
        expect(result.memoryRetrieval.topics).toEqual(['最近记忆回顾']);
    });

    test('should correct contradictory memory recall output that disables memory', async () => {
        const result = await analyzeCommand(
            { userCommand: '我们最近有聊过什么话题吗' },
            {
                generateText: mockGenerateText(JSON.stringify({
                    intent: 'memory_recall',
                    dialogueAct: 'new_request',
                    shouldRespond: true,
                    shouldEndSession: false,
                    memoryRetrieval: {
                        enabled: false,
                        mode: 'none',
                        query: '',
                        topics: [],
                        timeScope: 'unspecified',
                        confidence: 0,
                        reason: '没有之前的对话记录，无需检索记忆',
                    },
                    resolvedContext: {
                        isFollowUp: false,
                        topic: '最近记忆回顾',
                        rewrite: '',
                    },
                })),
            },
        );

        expect(result.intent).toBe('memory_recall');
        expect(result.memoryRetrieval.enabled).toBe(true);
        expect(result.memoryRetrieval.mode).toBe('recent_recall');
        expect(result.memoryRetrieval.query).toBe('我们最近有聊过什么话题吗');
        expect(result.memoryRetrieval.confidence).toBe(0.55);
    });

    test('should revise contradictory prior-topic clarification with deterministic rules', async () => {
        let callCount = 0;
        const result = await analyzeCommand(
            { userCommand: '我们之前都有聊过什么话题。' },
            {
                generateText: async () => {
                    callCount += 1;
                    if (callCount === 1) {
                        return {
                            text: JSON.stringify(validLayeredAnalysis({
                                routing: {
                                    action: 'ask_clarification',
                                    confidence: 0.7,
                                    reason: '最近对话为空，需要澄清具体指什么话题',
                                },
                                contextResolution: {
                                    isFollowUp: false,
                                    topic: '',
                                    responseRewrite: '您想了解我们之前讨论过的哪些话题？',
                                    memoryQueryRewrite: '',
                                    currentSessionSufficient: false,
                                },
                                dataPlan: {
                                    memory: {
                                        needed: false,
                                        mode: 'none',
                                        query: '',
                                        topics: [],
                                        canFetchInParallel: true,
                                        reason: '需要回顾之前的对话以确定用户想了解的话题',
                                        confidence: 0.7,
                                    },
                                    vision: { needed: false, canFetchInParallel: true, reason: '无需视觉' },
                                    deviceState: { needed: false, targets: [], reason: '' },
                                    safety: { riskLevel: 'none', requiresIdentity: false, requiresConfirmation: false, reason: '' },
                                },
                                intent: 'follow_up',
                                dialogueAct: 'new_request',
                            })),
                        } as any;
                    }

                    return {
                        text: JSON.stringify({
                            action: 'revise',
                            reason: '用户是在请求回顾长期对话主题，不应因当前会话为空而澄清。',
                            analysis: validLayeredAnalysis({
                                routing: {
                                    action: 'answer_after_context',
                                    confidence: 0.92,
                                    reason: '需要查询长期记忆后回答',
                                },
                                contextResolution: {
                                    isFollowUp: false,
                                    topic: '长期记忆回顾',
                                    responseRewrite: '回顾之前聊过的话题',
                                    memoryQueryRewrite: '之前聊过的话题',
                                    currentSessionSufficient: false,
                                },
                                dataPlan: {
                                    memory: {
                                        needed: true,
                                        mode: 'recent_recall',
                                        query: '之前聊过的话题',
                                        topics: ['长期记忆回顾'],
                                        canFetchInParallel: true,
                                        reason: '用户请求回顾历史对话主题',
                                        confidence: 0.92,
                                    },
                                    vision: { needed: false, canFetchInParallel: true, reason: '无需视觉' },
                                    deviceState: { needed: false, targets: [], reason: '' },
                                    safety: { riskLevel: 'none', requiresIdentity: false, requiresConfirmation: false, reason: '' },
                                },
                                intent: 'memory_recall',
                                dialogueAct: 'new_request',
                            }),
                        }),
                    } as any;
                },
            },
        );

        expect(callCount).toBe(1);
        expect(result.intent).toBe('memory_recall');
        expect(result.routing!.action).toBe('answer_after_context');
        expect(result.memoryRetrieval.enabled).toBe(true);
        expect(result.memoryRetrieval.mode).toBe('recent_recall');
        expect(result.memoryRetrieval.query).toBe('我们之前都有聊过什么话题。');
    });

    test('should use model output to rewrite short follow-ups with context', async () => {
        const recentConversationMessages: ConversationMessage[] = [
            {
                role: 'user',
                content: '请告诉我番茄炒蛋怎么做',
                createdAt: '2026-05-21T01:00:00.000Z',
            },
            {
                role: 'agent',
                content: '番茄炒蛋需要先炒鸡蛋再炒番茄。',
                createdAt: '2026-05-21T01:00:01.000Z',
            },
        ];

        const result = await analyzeCommand(
            {
                userCommand: '有什么需要注意的吗',
                recentConversationMessages,
            },
            {
                generateText: mockGenerateText(JSON.stringify({
                    intent: 'follow_up',
                    dialogueAct: 'follow_up',
                    shouldRespond: true,
                    shouldEndSession: false,
                    memoryRetrieval: {
                        enabled: true,
                        mode: 'semantic',
                        query: '番茄炒蛋 烹饪 注意事项 火候 调味',
                        topics: ['烹饪', '家常菜注意事项'],
                        timeScope: 'unspecified',
                        confidence: 0.9,
                        reason: '用户在追问上一轮烹饪主题',
                    },
                    resolvedContext: {
                        isFollowUp: true,
                        topic: '番茄炒蛋烹饪注意事项',
                        rewrite: '用户在追问番茄炒蛋制作过程中需要注意什么',
                    },
                })),
            },
        );

        expect(result.intent).toBe('follow_up');
        expect(result.memoryRetrieval.mode).toBe('semantic');
        expect(result.memoryRetrieval.query).toContain('注意事项');
        expect(result.resolvedContext.isFollowUp).toBe(true);
    });

    test('should use model output to avoid memory retrieval for device control', async () => {
        const result = await analyzeCommand(
            { userCommand: '开灯' },
            {
                generateText: mockGenerateText(JSON.stringify({
                    intent: 'device_control',
                    dialogueAct: 'new_request',
                    shouldRespond: true,
                    shouldEndSession: false,
                    memoryRetrieval: {
                        enabled: false,
                        mode: 'none',
                        query: '',
                        topics: ['智能家居照明'],
                        timeScope: 'unspecified',
                        confidence: 0.88,
                        reason: '纯设备控制不需要长期记忆',
                    },
                    resolvedContext: {
                        isFollowUp: false,
                        topic: '智能家居照明',
                        rewrite: '',
                    },
                })),
            },
        );

        expect(result.intent).toBe('device_control');
        expect(result.memoryRetrieval.mode).toBe('none');
        expect(result.memoryRetrieval.enabled).toBe(false);
    });

    test('should let model treat affirmative answer to recipe proposal as current-session follow-up', async () => {
        const recentConversationMessages: ConversationMessage[] = [
            {
                role: 'agent',
                content: '需要我再提供一些菜谱吗？',
                createdAt: '2026-05-21T01:00:00.000Z',
            },
        ];
        let callCount = 0;

        const result = await analyzeCommand(
            {
                userCommand: '可以呀',
                recentConversationMessages,
            },
            {
                generateText: async () => {
                    callCount += 1;
                    return {
                        text: JSON.stringify({
                            intent: 'follow_up',
                            dialogueAct: 'answer_to_assistant',
                            shouldRespond: true,
                            shouldEndSession: false,
                            memoryRetrieval: {
                                enabled: false,
                                mode: 'none',
                                query: '',
                                topics: ['烹饪/家常菜'],
                                timeScope: 'unspecified',
                                confidence: 0.9,
                                reason: '用户承接上一轮助手提议，使用当前会话上下文即可',
                            },
                            resolvedContext: {
                                isFollowUp: true,
                                topic: '烹饪/家常菜',
                                rewrite: '请继续提供新的家常菜菜谱',
                            },
                        }),
                    } as any;
                },
            },
        );

        expect(callCount).toBe(1);
        expect(result.intent).toBe('follow_up');
        expect(result.dialogueAct).toBe('answer_to_assistant');
        expect(result.memoryRetrieval.enabled).toBe(false);
        expect(result.memoryRetrieval.mode).toBe('none');
        expect(result.resolvedContext.rewrite).toBe('请继续提供新的家常菜菜谱');
    });

    test('should let model rewrite proposal answers without long-term memory retrieval', async () => {
        const recentConversationMessages: ConversationMessage[] = [
            {
                role: 'agent',
                content: '需要我再提供一些菜谱吗？',
                createdAt: '2026-05-21T01:00:00.000Z',
            },
        ];
        let callCount = 0;

        const result = await analyzeCommand(
            {
                userCommand: '来一个',
                recentConversationMessages,
            },
            {
                generateText: async () => {
                    callCount += 1;
                    return {
                        text: JSON.stringify({
                            intent: 'follow_up',
                            dialogueAct: 'answer_to_assistant',
                            shouldRespond: true,
                            shouldEndSession: false,
                            memoryRetrieval: {
                                enabled: false,
                                mode: 'none',
                                query: '',
                                topics: ['烹饪/家常菜'],
                                timeScope: 'unspecified',
                                confidence: 0.9,
                                reason: '用户承接上一轮助手提议，使用当前会话上下文即可',
                            },
                            resolvedContext: {
                                isFollowUp: true,
                                topic: '烹饪/家常菜',
                                rewrite: '请继续提供新的家常菜菜谱',
                            },
                        }),
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

    test('should not trigger recipe proposal handling without recent assistant proposal', async () => {
        const result = await analyzeCommand(
            { userCommand: '可以呀' },
            {
                generateText: mockGenerateText(JSON.stringify({
                    intent: 'acknowledgement',
                    dialogueAct: 'answer_to_assistant',
                    shouldRespond: false,
                    shouldEndSession: false,
                    memoryRetrieval: {
                        enabled: false,
                        mode: 'none',
                        query: '',
                        topics: [],
                        timeScope: 'unspecified',
                        confidence: 0.9,
                        reason: '没有最近助手提议，短确认语不可执行',
                    },
                    resolvedContext: {
                        isFollowUp: false,
                        topic: '',
                        rewrite: '',
                    },
                })),
            },
        );

        expect(result.intent).toBe('acknowledgement');
        expect(result.shouldRespond).toBe(false);
        expect(result.resolvedContext.rewrite).toBe('');
    });

    test('should fall back to semantic retrieval on invalid json', () => {
        const result = parseIntentionAnalysis('not json', '番茄炒蛋怎么做');

        expect(result.intent).toBe('qa');
        expect(result.visualUnderstanding.required).toBe(false);
        expect(result.memoryRetrieval.mode).toBe('semantic');
        expect(result.memoryRetrieval.query).toBe('番茄炒蛋怎么做');
        expect(result.memoryRetrieval.topics).toEqual([]);
    });

    test('should preserve model visual understanding decision', async () => {
        const result = await analyzeCommand(
            { userCommand: '这边情况怎么样' },
            {
                generateText: mockGenerateText(JSON.stringify({
                    intent: 'visual',
                    dialogueAct: 'new_request',
                    shouldRespond: true,
                    shouldEndSession: false,
                    visualUnderstanding: {
                        required: true,
                        reason: '用户需要根据当前画面判断现场状态',
                    },
                    memoryRetrieval: {
                        enabled: false,
                        mode: 'none',
                        query: '',
                        topics: ['视觉理解'],
                        timeScope: 'unspecified',
                        confidence: 0.91,
                        reason: '当前画面问题不需要长期记忆',
                    },
                    resolvedContext: {
                        isFollowUp: false,
                        topic: '视觉理解',
                        rewrite: '判断当前画面里的现场状态',
                    },
                })),
            },
        );

        expect(result.intent).toBe('visual');
        expect(result.visualUnderstanding.required).toBe(true);
        expect(result.visualUnderstanding.reason).toContain('当前画面');
        expect(result.memoryRetrieval.enabled).toBe(false);
    });

    test('should ask model to repair invalid output format before falling back', async () => {
        const calls: string[] = [];
        const result = await analyzeCommand(
            { userCommand: '帮我总结一下最近聊过的装修想法' },
            {
                generateText: async ({ messages }: any) => {
                    calls.push(messages[messages.length - 1].content);
                    if (calls.length === 1) {
                        return {
                            text: JSON.stringify({
                                intent: 'memory_recall',
                                memoryRetrieval: {
                                    enabled: true,
                                    mode: 'recent_recall',
                                    query: '装修想法',
                                    topics: ['装修'],
                                    timeScope: 'recent',
                                    confidence: 0.9,
                                    reason: '用户要求总结最近聊过的装修想法',
                                },
                            }),
                        } as any;
                    }
                    return {
                        text: JSON.stringify(validAnalysis({
                            intent: 'memory_recall',
                            dialogueAct: 'new_request',
                            memoryRetrieval: {
                                enabled: true,
                                mode: 'recent_recall',
                                query: '最近聊过的装修想法',
                                topics: ['装修/家居规划'],
                                timeScope: 'recent',
                                confidence: 0.9,
                                reason: '用户要求回顾最近聊过的装修想法',
                            },
                            resolvedContext: {
                                isFollowUp: false,
                                topic: '装修/家居规划',
                                rewrite: '总结最近聊过的装修想法',
                            },
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

    test('should let model disable memory and end session for closing answers', async () => {
        const recentConversationMessages: ConversationMessage[] = [
            {
                role: 'agent',
                content: '还有其他话题想讨论吗？',
                createdAt: '2026-05-21T01:00:00.000Z',
            },
        ];

        const result = await analyzeCommand(
            {
                userCommand: '暂时没有',
                recentConversationMessages,
            },
            {
                generateText: mockGenerateText(JSON.stringify({
                    intent: 'conversation_end',
                    dialogueAct: 'answer_to_assistant',
                    shouldRespond: true,
                    shouldEndSession: true,
                    memoryRetrieval: {
                        enabled: false,
                        mode: 'none',
                        query: '',
                        topics: [],
                        timeScope: 'unspecified',
                        confidence: 0.93,
                        reason: '用户回答助手的收尾问题，表示没有其他需求',
                    },
                    resolvedContext: {
                        isFollowUp: false,
                        topic: '对话结束',
                        rewrite: '',
                    },
                })),
            },
        );

        expect(result.intent).toBe('conversation_end');
        expect(result.dialogueAct).toBe('answer_to_assistant');
        expect(result.shouldEndSession).toBe(true);
        expect(result.memoryRetrieval.enabled).toBe(false);
        expect(result.memoryRetrieval.mode).toBe('none');
    });

    test('should let model ignore non-actionable input without memory retrieval', async () => {
        const result = await analyzeCommand(
            { userCommand: '嗯嗯' },
            {
                generateText: mockGenerateText(JSON.stringify({
                    intent: 'non_actionable',
                    dialogueAct: 'noise',
                    shouldRespond: false,
                    shouldEndSession: false,
                    memoryRetrieval: {
                        enabled: false,
                        mode: 'none',
                        query: '',
                        topics: [],
                        timeScope: 'unspecified',
                        confidence: 0.86,
                        reason: '输入缺少可执行或可回答内容',
                    },
                    resolvedContext: {
                        isFollowUp: false,
                        topic: '',
                        rewrite: '',
                    },
                })),
            },
        );

        expect(result.intent).toBe('non_actionable');
        expect(result.shouldRespond).toBe(false);
        expect(result.memoryRetrieval.enabled).toBe(false);
    });

    test('should fall back to recent context rewrite when model fails on short follow-up', async () => {
        const recentConversationMessages: ConversationMessage[] = [
            {
                role: 'user',
                content: '请告诉我番茄炒蛋怎么做',
                createdAt: '2026-05-21T01:00:00.000Z',
            },
        ];

        const result = await analyzeCommand(
            {
                userCommand: '有什么需要注意的吗',
                recentConversationMessages,
            },
            {
                generateText: async () => {
                    throw new Error('model unavailable');
                },
            },
        );

        expect(result.intent).toBe('follow_up');
        expect(result.memoryRetrieval.mode).toBe('semantic');
        expect(result.memoryRetrieval.query).toContain('番茄炒蛋');
    });
});
