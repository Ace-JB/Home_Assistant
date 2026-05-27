import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { HomeBrain } from '@modules/brain';
import type { ConversationMessage } from '@modules/memory';
import type { IntentionAnalysis } from '@modules/intention';

describe('HomeBrain', () => {
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
