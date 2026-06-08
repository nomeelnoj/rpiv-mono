/**
 * execute — the advisor side-call. Curates the executor's branch (inventory
 * prefix + tail massaging), invokes the advisor model via completeSimple with
 * no tools, and returns a structured tool result. Every result branch (success
 * / abort / error / empty) and the pre-call error paths funnel through
 * buildAdvisorResult so the envelope is built in exactly one place.
 */

import type { Api, Model, StopReason, Usage } from "@earendil-works/pi-ai";
import { completeSimple, type Message, type ThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parseModelKey } from "./config.js";
import { ensureUserTailForAdvisor, stripInflightAdvisorCall } from "./context.js";
import { getInventoryMessage } from "./inventory.js";
import {
	ADVISOR_CHAIN_PRIOR_INTRO,
	ERR_ABORTED_DETAIL,
	ERR_CALL_ABORTED,
	ERR_EMPTY_RESPONSE,
	ERR_EMPTY_RESPONSE_DETAIL,
	ERR_NO_MODEL,
	ERR_NO_MODEL_SELECTED,
	errCallFailed,
	errCallThrew,
	errMisconfigured,
	errNoApiKey,
	errNoApiKeyDetail,
	formatPriorAdvisorResponse,
	msgConsulting,
} from "./messages.js";
import { type ChainNode, findPerExecutorOverride, MAX_CHAIN_DEPTH, resolveAdvisorChain } from "./policy.js";
import { ADVISOR_SYSTEM_PROMPT } from "./prompt.js";
import { getAdvisorEffort, getAdvisorModel } from "./state.js";

/**
 * Resolve the advisor model + effort for this call.
 *
 * If the executor (`ctx.model`) matches a `perExecutor` entry AND the override's
 * advisor key resolves in the model registry, the override wins. Otherwise
 * fall back to the default advisor (`getAdvisorModel`/`getAdvisorEffort`).
 *
 * Registry-miss fallback is silent: the advisor call is hot-path and the
 * default model is already user-selected, so a missing override model is best
 * handled by quietly using the default rather than failing the call.
 *
 * Disable-wins: callers strip the advisor tool when `isExecutorBlocked` returns
 * true, so this resolver never sees blocked executors during normal flow.
 */
function resolveAdvisor(ctx: ExtensionContext): { advisor: Model<Api> | undefined; effort: ThinkingLevel | undefined } {
	const override = findPerExecutorOverride(ctx.model);
	if (override) {
		const parsed = parseModelKey(override.advisor);
		const overrideModel = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
		if (overrideModel) {
			return { advisor: overrideModel, effort: override.effort ?? getAdvisorEffort() };
		}
	}
	return { advisor: getAdvisorModel(), effort: getAdvisorEffort() };
}

interface AdvisorDetails {
	advisorModel?: string;
	effort?: ThinkingLevel;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}

// Single result-envelope builder — every executeAdvisor branch and the pre-call
// error paths funnel through here. `effort` is snapshotted once at executeAdvisor
// entry and threaded through every call so the returned details.effort always
// matches the value sent as `reasoning` to completeSimple, even if module-level
// state is mutated during the await window.
function buildAdvisorResult(opts: {
	text: string;
	effort: ThinkingLevel | undefined;
	advisorLabel?: string;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}): AgentToolResult<AdvisorDetails> {
	const details: AdvisorDetails = { effort: opts.effort };
	if (opts.advisorLabel !== undefined) details.advisorModel = opts.advisorLabel;
	if (opts.usage !== undefined) details.usage = opts.usage;
	if (opts.stopReason !== undefined) details.stopReason = opts.stopReason;
	if (opts.errorMessage !== undefined) details.errorMessage = opts.errorMessage;
	return { content: [{ type: "text", text: opts.text }], details };
}

function buildErrorResult(
	advisorLabel: string | undefined,
	effort: ThinkingLevel | undefined,
	userText: string,
	errorMessage: string,
): AgentToolResult<AdvisorDetails> {
	return buildAdvisorResult({ text: userText, effort, advisorLabel, errorMessage });
}

/** Optional chain-walk controls passed through from the tool call. */
export interface AdvisorCallParams {
	depth?: number;
	target?: string;
}

/**
 * Build the curated advisor branch once: the (cached) tool-inventory message and
 * the massaged executor branch. Both single-hop and chain walks share this so
 * every tier sees the same inventory + branch; chain tiers only prepend a
 * prior-responses message between the inventory and the branch.
 */
function buildAdvisorBranch(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): {
	inventoryMessage: Message | undefined;
	branchMessages: Message[];
} {
	const { messages: sessionMessages } = buildSessionContext(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getLeafId(),
	);
	const branchMessages = ensureUserTailForAdvisor(stripInflightAdvisorCall(convertToLlm(sessionMessages)));
	const inventoryMessage = getInventoryMessage(pi.getAllTools());
	return { inventoryMessage, branchMessages };
}

/** Extract and trim the text content of an advisor response. */
function extractText(content: { type: string }[]): string {
	return (content as { type: string; text?: string }[])
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

/**
 * Tool entry point. Dispatches to the single-hop path (default / `depth: 1` /
 * no target) or the chain-walk path (`depth > 1` or `target`). The single-hop
 * path is byte-for-byte the pre-chaining behavior, so the no-args call carries
 * zero regression risk. A chain request that resolves to no hops also falls
 * back to single-hop so `advisor({ depth: 2 })` with no route still helps.
 */
export async function executeAdvisor(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
	params: AdvisorCallParams = {},
): Promise<AgentToolResult<AdvisorDetails>> {
	const target = params.target?.trim() || undefined;
	const depthParam = params.depth;
	const useChain = (depthParam !== undefined && depthParam > 1) || target !== undefined;
	if (!useChain) {
		return executeSingleHop(ctx, pi, signal, onUpdate);
	}

	const depth = Math.min(MAX_CHAIN_DEPTH, Math.max(1, depthParam ?? MAX_CHAIN_DEPTH));
	const nodes = resolveAdvisorChain(ctx.model, depth, target, ctx.modelRegistry);
	if (nodes.length === 0) {
		// No chain available from this executor — preserve current useful behavior.
		return executeSingleHop(ctx, pi, signal, onUpdate);
	}
	return walkChain(ctx, pi, nodes, signal, onUpdate);
}

async function executeSingleHop(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
): Promise<AgentToolResult<AdvisorDetails>> {
	// Snapshot advisor + effort once at entry — every result envelope and the
	// API call itself use these same values so a concurrent setAdvisorEffort()
	// or perExecutor cache change during the await window cannot desync
	// details.effort/advisorModel from the `reasoning` and model actually sent.
	// resolveAdvisor consults the perExecutor routing table first and falls
	// back to the default selection on miss.
	const { advisor, effort } = resolveAdvisor(ctx);
	if (!advisor) {
		return buildErrorResult(undefined, effort, ERR_NO_MODEL, ERR_NO_MODEL_SELECTED);
	}
	const advisorLabel = `${advisor.provider}:${advisor.id}`;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisor);
	if (!auth.ok) {
		return buildErrorResult(advisorLabel, effort, errMisconfigured(advisorLabel, auth.error), auth.error);
	}
	if (!auth.apiKey) {
		return buildErrorResult(advisorLabel, effort, errNoApiKey(advisorLabel), errNoApiKeyDetail(advisor.provider));
	}

	// Live-read every call — advisor runs mid-turn so any message_end snapshot
	// is always one turn stale. buildSessionContext() preserves Pi's resolved
	// LLM context, including compaction summaries and branch summaries, instead
	// of replaying raw pre-compaction branch messages. convertToLlm is
	// pass-through for user/assistant/toolResult (messages.js:111-114), so
	// element refs are stable across calls via the session store.
	const { inventoryMessage, branchMessages } = buildAdvisorBranch(ctx, pi);
	const messages: Message[] = inventoryMessage ? [inventoryMessage, ...branchMessages] : branchMessages;

	onUpdate?.({
		content: [{ type: "text", text: msgConsulting(advisorLabel, effort) }],
		details: { advisorModel: advisorLabel, effort },
	});

	try {
		const response = await completeSimple(
			advisor,
			// `tools: []` reaffirms the "never calls tools" contract even when
			// `messages` contains prior toolCall/toolResult blocks (btw.ts:235).
			{ systemPrompt: ADVISOR_SYSTEM_PROMPT, messages, tools: [] },
			{ apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: effort },
		);

		if (response.stopReason === "aborted") {
			return buildAdvisorResult({
				text: ERR_CALL_ABORTED,
				effort,
				advisorLabel,
				usage: response.usage,
				stopReason: response.stopReason,
				errorMessage: response.errorMessage ?? ERR_ABORTED_DETAIL,
			});
		}

		if (response.stopReason === "error") {
			return buildAdvisorResult({
				text: errCallFailed(response.errorMessage),
				effort,
				advisorLabel,
				usage: response.usage,
				stopReason: response.stopReason,
				errorMessage: response.errorMessage,
			});
		}

		const advisorText = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (!advisorText) {
			return buildAdvisorResult({
				text: ERR_EMPTY_RESPONSE,
				effort,
				advisorLabel,
				usage: response.usage,
				stopReason: response.stopReason,
				errorMessage: ERR_EMPTY_RESPONSE_DETAIL,
			});
		}

		return buildAdvisorResult({
			text: advisorText,
			effort,
			advisorLabel,
			usage: response.usage,
			stopReason: response.stopReason,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return buildErrorResult(advisorLabel, effort, errCallThrew(message), message);
	}
}

/**
 * Synthetic `user` message that threads prior advisor responses into a deeper
 * tier's context. Inserted after the inventory message and before the executor
 * branch so the tier sees: tool inventory → prior advice → the conversation.
 */
function buildPriorResponsesMessage(prior: { label: string; text: string }[]): Message {
	const body = prior.map((p, i) => formatPriorAdvisorResponse(i + 1, p.label, p.text)).join("\n\n");
	return {
		role: "user",
		content: [{ type: "text", text: `${ADVISOR_CHAIN_PRIOR_INTRO}\n\n${body}` }],
		timestamp: Date.now(),
	};
}

/**
 * Walk a resolved advisor chain sequentially. Each tier sees the same inventory
 * + executor branch; tiers after the first also receive a prepended
 * prior-responses message. The final completed tier's response is returned.
 *
 * Failure handling preserves single-hop semantics: at tier 1 a failure (auth,
 * abort, error, empty, throw) returns that tier's normal envelope. After at
 * least one successful tier, any later-tier failure returns the last completed
 * tier's response — the partial chain output is still useful, so failures are
 * not surfaced to the executor. Effort inheritance mirrors depth-1 resolution:
 * tier 1's effective effort is `entry.effort ?? getAdvisorEffort()`, and deeper
 * tiers use their own `entry.effort` or fall back to that tier-1 effort.
 */
async function walkChain(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	nodes: ChainNode[],
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
): Promise<AgentToolResult<AdvisorDetails>> {
	const { inventoryMessage, branchMessages } = buildAdvisorBranch(ctx, pi);
	const firstTierEffort = nodes[0].effort ?? getAdvisorEffort();
	const priorResponses: { label: string; text: string }[] = [];
	let lastResult: AgentToolResult<AdvisorDetails> | undefined;

	for (const node of nodes) {
		const advisor = node.model;
		const advisorLabel = `${advisor.provider}:${advisor.id}`;
		const effort = node.effort ?? firstTierEffort;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisor);
		if (!auth.ok) {
			return buildErrorResult(advisorLabel, effort, errMisconfigured(advisorLabel, auth.error), auth.error);
		}
		if (!auth.apiKey) {
			return buildErrorResult(advisorLabel, effort, errNoApiKey(advisorLabel), errNoApiKeyDetail(advisor.provider));
		}

		const priorMessage = priorResponses.length > 0 ? buildPriorResponsesMessage(priorResponses) : undefined;
		const messages: Message[] = [
			...(inventoryMessage ? [inventoryMessage] : []),
			...(priorMessage ? [priorMessage] : []),
			...branchMessages,
		];

		onUpdate?.({
			content: [{ type: "text", text: msgConsulting(advisorLabel, effort) }],
			details: { advisorModel: advisorLabel, effort },
		});

		try {
			const response = await completeSimple(
				advisor,
				{ systemPrompt: ADVISOR_SYSTEM_PROMPT, messages, tools: [] },
				{ apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: effort },
			);

			if (response.stopReason === "aborted") {
				if (lastResult) return lastResult;
				return buildAdvisorResult({
					text: ERR_CALL_ABORTED,
					effort,
					advisorLabel,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage ?? ERR_ABORTED_DETAIL,
				});
			}

			if (response.stopReason === "error") {
				return buildAdvisorResult({
					text: errCallFailed(response.errorMessage),
					effort,
					advisorLabel,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage,
				});
			}

			const advisorText = extractText(response.content);
			if (!advisorText) {
				return buildAdvisorResult({
					text: ERR_EMPTY_RESPONSE,
					effort,
					advisorLabel,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: ERR_EMPTY_RESPONSE_DETAIL,
				});
			}

			priorResponses.push({ label: advisorLabel, text: advisorText });
			lastResult = buildAdvisorResult({
				text: advisorText,
				effort,
				advisorLabel,
				usage: response.usage,
				stopReason: response.stopReason,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return buildErrorResult(advisorLabel, effort, errCallThrew(message), message);
		}
	}

	// nodes is non-empty (guaranteed by caller) and every tier either returned
	// early or set lastResult, so this is always defined.
	return lastResult as AgentToolResult<AdvisorDetails>;
}
