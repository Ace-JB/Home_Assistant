import { expect, test, describe } from "bun:test";
import {
    calculateTextSimilarity,
    estimateSpeechUnits,
    hasBargeInKeyword,
    isEchoLikeTranscript,
    createCosyVoiceServiceErrorForTest,
    extractSpeechReadyChunk,
    isValidBargeInTranscript,
    normalizeTranscript,
    shouldFallbackToSay,
    splitCosyVoiceSpeechChunks,
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
        expect(chunk?.chunk).toBe("我先帮你整理一下当前已经识别到的几个关键信息，");
        expect(chunk?.rest).toBe("然后继续说明后续步骤。");
    });

    test("should use elastic punctuation windows instead of fixed length cuts", () => {
        const text = "在烹饪红烧牛肉时，请注意火候的控制，确保牛肉炖得足够软烂。同时，调味料的比例要适当调整，以符合您的口味。祝您烹饪愉快！";
        const chunks: string[] = [];
        let rest = text;
        let next = extractSpeechReadyChunk(rest, 28);
        while (next) {
            chunks.push(next.chunk);
            rest = next.rest;
            next = extractSpeechReadyChunk(rest, 28);
        }
        chunks.push(...splitCosyVoiceSpeechChunks(rest, { minUnits: 28, maxUnits: 60 }));

        expect(chunks).toEqual([
            "在烹饪红烧牛肉时，请注意火候的控制，",
            "确保牛肉炖得足够软烂。",
            "同时，调味料的比例要适当调整，",
            "以符合您的口味。",
            "祝您烹饪愉快！",
        ]);
        expect(chunks).not.toContain("确保");
        expect(chunks).not.toContain("以符合您的");
    });

    test("should not split short soft punctuation before the elastic window", () => {
        expect(extractSpeechReadyChunk("在烹饪红烧牛肉时，请注意", 28)).toBeNull();
    });

    test("should fallback split long text without punctuation", () => {
        const chunk = extractSpeechReadyChunk("这是一段没有标点但是已经足够长所以需要平滑切出来继续播放".repeat(3), 18);

        expect(chunk?.chunk.length).toBeGreaterThanOrEqual(18);
        expect(chunk?.rest.length).toBeGreaterThan(0);
    });

    test("should keep sentence punctuation attached to the preceding cosyvoice chunk", () => {
        const chunks = splitCosyVoiceSpeechChunks("你好。下一句！后面继续？", { minUnits: 1, maxUnits: 6 });

        expect(chunks).toEqual(["你好。", "下一句！", "后面继续？"]);
        expect(chunks.every(chunk => !/^[。！？!?；;]/u.test(chunk))).toBe(true);
    });

    test("should force split long punctuation-free cjk text near max units", () => {
        const text = "今天天气很好适合把所有需要处理的事情按照优先级慢慢整理清楚".repeat(12);
        const chunks = splitCosyVoiceSpeechChunks(text, { minUnits: 28, maxUnits: 60 });

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.join("")).toBe(text);
        expect(chunks.slice(0, -1).every(chunk => estimateSpeechUnits(chunk) <= 60)).toBe(true);
    });

    test("should merge dense short punctuation into one cosyvoice chunk", () => {
        const chunks = splitCosyVoiceSpeechChunks("啊！哦？好吧。嗯……", { minUnits: 28, maxUnits: 60 });

        expect(chunks).toEqual(["啊！哦？好吧。嗯……"]);
    });

    test("should flush short final text regardless of punctuation thresholds", () => {
        const chunks = splitCosyVoiceSpeechChunks("祝您烹饪愉快！", { minUnits: 28, maxUnits: 60 });

        expect(chunks).toEqual(["祝您烹饪愉快！"]);
    });

    test("should not split english words versions or urls in mixed text", () => {
        const text = "TypeScript system architecture configuration uses v1.2.3 and https://example.com/docs/architecture before explaining 下一步应该怎么做以及为什么这样更稳定可靠";
        const chunks = splitCosyVoiceSpeechChunks(text, { minUnits: 8, maxUnits: 18 });

        expect(chunks.join("").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
        expect(chunks.some(chunk => chunk.includes("architecture"))).toBe(true);
        expect(chunks.some(chunk => chunk.includes("v1.2.3"))).toBe(true);
        expect(chunks.some(chunk => chunk.includes("https://example.com/docs/architecture"))).toBe(true);
        expect(chunks.join("|")).not.toMatch(/archi\|tecture|v1\.\|2\.3|docs\/\|architecture/);
    });

    test("should split cjk earlier than english for the same visible length", () => {
        const cjk = "这是一段中文内容用来验证朗读单位权重会让中文更早切分".repeat(4);
        const english = "architecture configuration TypeScript service routing ".repeat(4);

        const cjkChunks = splitCosyVoiceSpeechChunks(cjk, { minUnits: 12, maxUnits: 30 });
        const englishChunks = splitCosyVoiceSpeechChunks(english, { minUnits: 12, maxUnits: 30 });

        expect(cjkChunks.length).toBeGreaterThan(englishChunks.length);
    });

    test("should preserve a short final tail", () => {
        const text = "第一部分内容比较长需要先说完。最后好。";
        const chunks = splitCosyVoiceSpeechChunks(text, { minUnits: 10, maxUnits: 14 });

        expect(chunks.join("")).toBe(text);
        expect(chunks.at(-1)).toContain("最后好。");
    });

    test("should fallback to say for CosyVoice service errors only", () => {
        expect(shouldFallbackToSay(createCosyVoiceServiceErrorForTest("unreachable"))).toBe(true);
        expect(shouldFallbackToSay(new Error("bad prompt config"))).toBe(false);
    });
});
