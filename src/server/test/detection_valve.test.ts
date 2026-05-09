import { expect, test, describe, beforeEach } from "bun:test";
import { faceValue } from "../tools/WiseRelex";

describe("DetectionValve", () => {
    test("should allow execution based on frequency", async () => {
        // faceValue is already instantiated with GLOBAL_CONFIG.FACE.PROCESS_HZ (default 2)
        // So interval is 500ms
        
        expect(faceValue.canExecute()).toBe(true);
        expect(faceValue.canExecute()).toBe(false); // Second call immediately after should be false
        
        await new Promise(resolve => setTimeout(resolve, 600));
        expect(faceValue.canExecute()).toBe(true);
    });
});
