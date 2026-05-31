import { expect, test, describe } from "bun:test";
import {
    calculateTextSimilarity,
    hasBargeInKeyword,
    isEchoLikeTranscript,
    extractSpeechReadyChunk,
    isValidBargeInTranscript,
    normalizeTranscript,
} from "@tools/Voice";

describe("Voice Utils", () => {
    test("should normalize transcript and remove garbage patterns", () => {
        const input = "[00:00.000 -> 00:05.000] 请用简体中文清晰地回答\n[00:05.000 -> 00:10.000] 你好，请帮我开灯。";
        const expected = "你好，请帮我开灯。";
        expect(normalizeTranscript(input)).toBe(expected);
    });

    test("should remove content in parentheses", () => {
        const input = "你好 (笑声) 很高兴见到你";
        const expected = "你好 很高兴见到你";
        expect(normalizeTranscript(input)).toBe(expected);
    });

    test("should filter out short lines", () => {
        const input = "a\n你好";
        const expected = "你好";
        expect(normalizeTranscript(input)).toBe(expected);
    });

    test("should remove multiple spaces", () => {
        const input = "你好    管家";
        const expected = "你好 管家";
        expect(normalizeTranscript(input)).toBe(expected);
    });

    test("should detect echo-like transcripts", () => {
        const spoken = "番茄炒蛋的做法如下，先炒鸡蛋，再炒番茄。";

        expect(isEchoLikeTranscript("番茄炒蛋的做法如下，先炒鸡蛋", spoken, 0.65)).toBe(true);
        expect(isEchoLikeTranscript("不是这个，我刚才说错了", spoken, 0.65)).toBe(false);
    });

    test("should calculate lower similarity for unrelated text", () => {
        const similarity = calculateTextSimilarity("请停一下", "番茄炒蛋的做法如下");

        expect(similarity).toBeLessThan(0.65);
    });

    test("should filter invalid barge-in candidates", () => {
        expect(isValidBargeInTranscript("嗯", "蛋蛋")).toBe(false);
        expect(isValidBargeInTranscript("蛋蛋", "蛋蛋")).toBe(false);
        expect(isValidBargeInTranscript("停一下，我说错了", "蛋蛋")).toBe(true);
    });

    test("should detect configured barge-in keywords", () => {
        const keywords = ["停一下", "别说了", "wait"];

        expect(hasBargeInKeyword("请停一下", keywords)).toBe(true);
        expect(hasBargeInKeyword("WAIT a second", keywords)).toBe(true);
        expect(hasBargeInKeyword("继续说", keywords)).toBe(false);
        expect(isValidBargeInTranscript("停", "蛋蛋", ["停"])).toBe(true);
    });

    test("should split speech chunks on Chinese sentence boundaries", () => {
        const first = extractSpeechReadyChunk("今天可以先处理日程。然后我再提醒你。");

        expect(first).toEqual({
            chunk: "今天可以先处理日程。",
            rest: "然后我再提醒你。",
        });
    });

    test("should wait for short soft punctuation before splitting", () => {
        expect(extractSpeechReadyChunk("好的，")).toBeNull();
        expect(extractSpeechReadyChunk("好的，我现在帮你查一下")).toBeNull();

        const chunk = extractSpeechReadyChunk("我先帮你整理一下当前已经识别到的几个关键信息，然后继续说明后续步骤。");
        expect(chunk).toEqual({
            chunk: "我先帮你整理一下当前已经识别到的几个关键信息，",
            rest: "然后继续说明后续步骤。",
        });
    });

    test("should fallback split long text without punctuation", () => {
        const chunk = extractSpeechReadyChunk("This is a long response without punctuation but it should speak progressively", 18);

        expect(chunk?.chunk.length).toBeGreaterThanOrEqual(18);
        expect(chunk?.rest.length).toBeGreaterThan(0);
    });
});
