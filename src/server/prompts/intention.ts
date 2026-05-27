import type { AssistantLanguage } from '@tools/Socket';

export function getIntentionSystemPrompt(language: AssistantLanguage = 'zh'): string {
    if (language === 'en') {
        return `You are an intent analyst for a home assistant. Infer the user's goal dynamically from meaning and recent dialogue, not from fixed keywords. Output only strict JSON. Do not answer the user. Do not invent long-term memories.`;
    }

    return `你是家庭助手的意图分析器。请根据用户命令和最近对话动态推断用户目标，不要依赖固定关键词。只输出严格 JSON，不要回答用户问题，不要编造长期记忆。`;
}

export function buildIntentionUserPrompt(input: {
    userCommand: string;
    recentConversationText: string;
}): string {
    return `Command: ${input.userCommand}
Recent conversation:
${input.recentConversationText || '(none)'}

Guidelines:
- topics must be abstract semantic topics, such as "烹饪/家常菜", "智能家居照明", "最近记忆回顾", not merely copied item names.
- If the command is a follow-up, rewrite it into a self-contained memory search query using recent conversation.
- Use recent_recall only when the user asks to review past conversations or memories.
- Recent conversation is only the current wake session. If it is empty, that does not mean long-term memory is empty. When the user asks to review prior conversations or remembered topics, enable long-term memory retrieval with mode recent_recall.
- Let memoryRetrieval.enabled be the final decision on whether long-term memory is useful. Use false and mode none for closings, acknowledgements, noise, pure device control, or inputs that do not benefit from long-term memory.
- If the user is semantically declining or ending after the assistant's closing question, classify as conversation_end, dialogueAct closing or answer_to_assistant, shouldEndSession true, and do not retrieve memory.
- If the input is only a brief acknowledgement without a new request, classify as acknowledgement and do not retrieve memory.
- If the input appears meaningless, accidental, or ASR noise, classify as non_actionable, shouldRespond false, and do not retrieve memory.
- Set visualUnderstanding.required true only when the user needs the assistant to inspect or reason about the current camera frame, image, scene, person, object, pose, gesture, or visible state. Do this from semantic intent and recent dialogue, not keyword matching.

Return JSON exactly like:
{
  "intent": "qa | follow_up | memory_recall | visual | device_control | chitchat | conversation_end | acknowledgement | non_actionable",
  "dialogueAct": "new_request | follow_up | answer_to_assistant | closing | noise",
  "shouldRespond": true,
  "shouldEndSession": false,
  "visualUnderstanding": {
    "required": false,
    "reason": "why visual understanding is or is not needed"
  },
  "memoryRetrieval": {
    "enabled": true,
    "mode": "semantic | recent_recall | hybrid | none",
    "query": "rewritten memory search query",
    "topics": ["topic"],
    "timeScope": "recent | all | unspecified",
    "confidence": 0.0,
    "reason": "why long-term memory is or is not needed"
  },
  "resolvedContext": {
    "isFollowUp": false,
    "topic": "",
    "rewrite": ""
  }
}`;
}
