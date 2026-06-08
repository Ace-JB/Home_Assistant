import { describe, expect, test } from 'bun:test';
import { analyzeCommand, parseIntentionAnalysis } from '@modules/intention';
import type { ConversationMessage } from '@modules/memory';

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
    test('parses core direct answer without memory retrieval', async () => {
        const result = await analyzeCommand(
            { userCommand: '今天适合做什么晚饭' },
            { generateText: mockGenerateText(JSON.stringify(coreDecision())) },
        );

        expect(result.routing?.action).toBe('direct_answer');
        expect(result.dataPlan?.memory.needed).toBe(false);
        expect(result.memoryRetrieval.enabled).toBe(false);
        expect(result.resolvedContext.rewrite).toBe('default query');
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
            { userCommand: '帮我总结一下最近聊过的装修想法' },
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

    test('falls back to recent context rewrite when model fails on short follow-up', async () => {
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
