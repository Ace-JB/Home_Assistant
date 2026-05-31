import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { HomeBrain } from '@modules/brain';
import { buildMemoryPruneUserPrompt } from '@server/prompts';
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
                        }];
                    },
                },
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
        expect(generatedPrompt).toContain('画面里台面有锅具');
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
        expect(calls[0].messages[0].content).toBeArray();
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

        const imagePart = calls[0].messages[0].content[1];
        expect(imagePart.image).toBeInstanceOf(Buffer);
        expect(imagePart.image.length).toBeGreaterThan(0);
        expect(imagePart.image[0]).toBe(0xff);
        expect(imagePart.image[1]).toBe(0xd8);
    });
});
