export type WakeCommandExtraction = {
    hasWakeWord: boolean;
    command: string;
    prefixNoiseChars: number;
    normalizedCommandChars: number;
};

export function normalizeWakeText(value: string): string {
    return value.toLowerCase().replace(/[^\p{Script=Han}\p{L}\p{N}]+/gu, '');
}

export function hasWakeWordInText(text: string, wakeWord: string): boolean {
    return normalizeWakeText(text).includes(normalizeWakeText(wakeWord));
}

export function hasMeaningfulWakeCommand(command: string): boolean {
    return normalizeWakeText(command).length > 1;
}

export function extractWakeCommand(text: string, wakeWord: string): WakeCommandExtraction {
    const directIndex = text.indexOf(wakeWord);
    if (directIndex >= 0) {
        const command = text.slice(directIndex + wakeWord.length).trim();
        return {
            hasWakeWord: true,
            command,
            prefixNoiseChars: normalizeWakeText(text.slice(0, directIndex)).length,
            normalizedCommandChars: normalizeWakeText(command).length,
        };
    }

    const normalizedWakeWord = normalizeWakeText(wakeWord);
    let normalizedIndex = 0;
    let commandStart = -1;
    let prefixNoiseChars = 0;
    for (let index = 0; index < text.length; index++) {
        const char = text[index] ?? '';
        const normalizedChar = normalizeWakeText(char);
        if (!normalizedChar) continue;
        if (normalizedChar === normalizedWakeWord[normalizedIndex]) {
            normalizedIndex += 1;
            if (normalizedIndex === normalizedWakeWord.length) {
                commandStart = index + 1;
                prefixNoiseChars = Math.max(0, normalizeWakeText(text.slice(0, index + 1)).length - normalizedWakeWord.length);
                break;
            }
        } else {
            normalizedIndex = normalizedChar === normalizedWakeWord[0] ? 1 : 0;
        }
    }
    const command = commandStart >= 0 ? text.slice(commandStart).trim() : '';
    return {
        hasWakeWord: commandStart >= 0,
        command,
        prefixNoiseChars,
        normalizedCommandChars: normalizeWakeText(command).length,
    };
}
