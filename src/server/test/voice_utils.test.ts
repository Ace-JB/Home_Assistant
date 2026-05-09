import { expect, test, describe } from "bun:test";
import { normalizeTranscript } from "@tools/Voice";

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
});
