import type { AssistantLanguage } from '@tools/Socket';

export function getIntentionSystemPrompt(language: AssistantLanguage = 'zh'): string {
    if (language === 'en') {
        return `You are an intent analyst for a home assistant. Infer the user's goal dynamically from meaning and recent dialogue, not from fixed keywords.

Decision method:
1. Route first: decide whether the input should be ignored, ends the session, can be answered directly, controls a device, needs extra context, needs clarification, or must be refused.
2. Resolve context: decide whether this is a follow-up and rewrite the user request into a self-contained response request and memory search query only when evidence supports it.
3. Plan data needs: decide independently whether long-term memory, current camera vision, device state, or safety/identity context is needed. Mark data that can be fetched in parallel.
4. Plan the response shape: brief answer, brief confirmation, one clarification question, or refusal.

Think through these steps internally, then output only strict JSON. Do not expose chain-of-thought, do not answer the user, and do not invent long-term memories.`;
    }

    return `你是家庭助手的意图分析器。请根据用户命令和最近对话动态推断用户目标，不要依赖固定关键词。

决策方法：
1. 先做路由：判断输入应忽略、结束会话、可直接回答、设备控制、需要补充上下文、需要澄清，还是必须拒绝。
2. 再解析上下文：判断是否追问；只有在证据支持时，才把用户请求改写成自洽的回复请求和记忆检索 query。
3. 再规划数据需求：分别判断是否需要长期记忆、当前摄像头视觉、设备状态、身份/安全上下文，并标记可并行获取的数据。
4. 最后规划回复形态：简短回答、简短确认、只问一个澄清问题，或简短拒绝。

请在内部完成上述判断，然后只输出严格 JSON。不要暴露思维链，不要回答用户问题，不要编造长期记忆。`;
}

export function buildIntentionUserPrompt(input: {
    userCommand: string;
    recentConversationText: string;
}): string {
    return `Command: ${input.userCommand}
Recent conversation:
${input.recentConversationText || '(none)'}

Guidelines:
- Before choosing fields, internally compare at least these options: immediate route vs needs context, new request vs follow-up, answer-to-assistant vs acknowledgement, visual need vs text-only answer, long-term memory useful vs unnecessary.
- topics must be abstract semantic topics, such as "烹饪/家常菜", "智能家居照明", "最近记忆回顾", not merely copied item names.
- If the command is a follow-up, produce a self-contained responseRewrite and memoryQueryRewrite using recent conversation.
- Use recent_recall only when the user asks to review past conversations or memories.
- Recent conversation is only the current wake session. If it is empty, that does not mean long-term memory is empty. When the user asks to review prior conversations or remembered topics, enable long-term memory retrieval with mode recent_recall.
- Let dataPlan.memory.needed be the final decision on whether long-term memory is useful. Use false and mode none for closings, acknowledgements, noise, pure device control, or inputs that do not benefit from long-term memory.
- If the user is semantically declining or ending after the assistant's closing question, classify as conversation_end, dialogueAct closing or answer_to_assistant, shouldEndSession true, and do not retrieve memory.
- If the input is only a brief acknowledgement without a new request, classify as acknowledgement and do not retrieve memory.
- If the input appears meaningless, accidental, or ASR noise, classify as non_actionable, shouldRespond false, and do not retrieve memory.
- Set dataPlan.vision.needed true only when the user needs the assistant to inspect or reason about the current camera frame, image, scene, person, object, pose, gesture, or visible state. Do this from semantic intent and recent dialogue, not keyword matching.
- Set routing.action to answer_after_context when memory or vision is needed before answering.
- Do not use memory merely because memory exists; use it only if it can change the answer.

Return JSON exactly like:
{
  "routing": {
    "action": "ignore | end_session | direct_answer | execute_device | answer_after_context | ask_clarification | refuse",
    "confidence": 0.0,
    "reason": "why this route is appropriate"
  },
  "contextResolution": {
    "isFollowUp": false,
    "topic": "",
    "responseRewrite": "self-contained request for final answer",
    "memoryQueryRewrite": "self-contained query for memory retrieval",
    "currentSessionSufficient": true
  },
  "dataPlan": {
    "memory": {
      "needed": false,
      "mode": "semantic | recent_recall | hybrid | none",
      "query": "",
      "topics": ["topic"],
      "canFetchInParallel": true,
      "reason": "why memory is or is not needed",
      "confidence": 0.0
    },
    "vision": {
      "needed": false,
      "canFetchInParallel": true,
      "reason": "why current camera vision is or is not needed"
    },
    "deviceState": {
      "needed": false,
      "targets": [],
      "reason": "which device state is needed, if any"
    },
    "safety": {
      "riskLevel": "none | privacy | device_risk | emergency",
      "requiresIdentity": false,
      "requiresConfirmation": false,
      "reason": "safety or permission concern"
    }
  },
  "responsePlan": {
    "style": "brief_answer | brief_confirm | clarification_question | refusal",
    "clarificationQuestion": ""
  },
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
