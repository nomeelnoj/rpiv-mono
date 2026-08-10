/**
 * context — branch-message massaging for the advisor side-call. Strips the
 * executor's in-flight advisor() toolCall from the tail (orphan toolCalls are
 * rejected by providers), flattens the branch's tool-call/tool-result blocks
 * into plain text (see flattenToolBlocksForAdvisor), and guarantees a user-role
 * tail (some providers reject an assistant-prefill tail).
 */

import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { ADVISOR_TOOL_NAME, MSG_ADVISOR_NUDGE } from "./messages.js";

// Strip the executor's in-flight advisor() toolCall from the tail assistant
// message. That call is what invoked *us* — there is no matching toolResult
// yet, and providers (Anthropic, GLM/zai, OpenAI) reject payloads with orphan
// toolCalls. Name-targeted to leave any other trailing toolCalls visible.
export function stripInflightAdvisorCall(messages: Message[]): Message[] {
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role !== "assistant") return messages;
	const filtered = last.content.filter((c) => !(c.type === "toolCall" && c.name === ADVISOR_TOOL_NAME));
	if (filtered.length === last.content.length) return messages;
	if (filtered.length === 0) return messages.slice(0, -1);
	return [...messages.slice(0, -1), { ...last, content: filtered }];
}

// The advisor side-call is issued with `tools: []` (it must never call tools),
// but a continued session's branch still carries the executor's prior toolCall
// and toolResult blocks. Amazon Bedrock's Converse API rejects that combination
// outright — "The toolConfig field must be defined when using toolUse and
// toolResult content blocks" — because no toolConfig accompanies an empty tool
// list. Rather than advertise tools we won't honor, flatten every tool block
// into plain text so the transcript reads the same to the advisor while the
// request carries no tool blocks. The tool inventory is already supplied to the
// advisor as a separate text message, so no fidelity is lost.
//
// toolCall blocks (assistant role) become text; whole toolResult messages become
// user-role text messages (image results are preserved as image blocks, still
// valid on a user turn). Because a run of toolResult messages collapses into
// consecutive user messages, adjacent same-role messages are then coalesced so
// the result keeps clean user/assistant alternation for strict providers.
function renderToolCall(block: ToolCall): TextContent {
	let args: string;
	try {
		args = JSON.stringify(block.arguments ?? {});
	} catch {
		args = "{\u2026}";
	}
	return { type: "text", text: `[tool call \u2192 ${block.name}] ${args}` };
}

function toolResultToUserMessage(msg: ToolResultMessage): UserMessage {
	const label = `[tool result \u2190 ${msg.toolName}${msg.isError ? " (error)" : ""}]`;
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: label }];
	for (const c of msg.content) {
		if (c.type === "text" || c.type === "image") content.push(c);
	}
	return { role: "user", content, timestamp: msg.timestamp };
}

function stripToolCallsFromAssistant(msg: AssistantMessage): AssistantMessage {
	if (!msg.content.some((c) => c.type === "toolCall")) return msg;
	const content = msg.content.map((c) => (c.type === "toolCall" ? renderToolCall(c) : c));
	return { ...msg, content };
}

function userContentArray(msg: UserMessage): (TextContent | ImageContent)[] {
	return typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content;
}

// Merge adjacent messages that share the same user/assistant role into one, so
// the toolResult→user rewrite above cannot produce two consecutive user turns.
function coalesceSameRole(messages: Message[]): Message[] {
	const out: Message[] = [];
	for (const m of messages) {
		const prev = out[out.length - 1];
		if (prev?.role === "user" && m.role === "user") {
			out[out.length - 1] = { ...prev, content: [...userContentArray(prev), ...userContentArray(m)] };
		} else if (prev?.role === "assistant" && m.role === "assistant") {
			out[out.length - 1] = { ...prev, content: [...prev.content, ...m.content] };
		} else {
			out.push(m);
		}
	}
	return out;
}

export function flattenToolBlocksForAdvisor(messages: Message[]): Message[] {
	const flattened = messages.map((m): Message => {
		if (m.role === "toolResult") return toolResultToUserMessage(m);
		if (m.role === "assistant") return stripToolCallsFromAssistant(m);
		return m;
	});
	return coalesceSameRole(flattened);
}

// Some providers (recent Anthropic Claude models) reject payloads ending on an
// assistant turn ("This model does not support assistant message prefill. The
// conversation must end with a user message."). After stripInflightAdvisorCall
// the tail can be assistant (e.g. the executor wrote thinking text before
// calling advisor). Append a minimal user-role nudge to guarantee user-tail.
export function ensureUserTailForAdvisor(messages: Message[]): Message[] {
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role !== "assistant") return messages;
	const nudge: Message = {
		role: "user",
		content: [{ type: "text", text: MSG_ADVISOR_NUDGE }],
		timestamp: Date.now(),
	};
	return [...messages, nudge];
}
