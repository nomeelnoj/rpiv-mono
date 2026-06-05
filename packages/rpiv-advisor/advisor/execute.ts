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
	msgConsulting,
} from "./messages.js";
import { findPerExecutorOverride } from "./policy.js";
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
/**
 * Resolve the advisor's API key across runtimes. Upstream Pi exposes
 * `modelRegistry.getApiKeyAndHeaders(model)` (returning an ok/error envelope
 * with apiKey + headers); omp's ModelRegistry exposes `getApiKey(model)`
 * returning the key directly (auth headers are applied by the provider
 * transport from the model's provider config). Detect whichever is present.
 */
async function getAdvisorAuth(
	ctx: ExtensionContext,
	advisor: Model<Api>,
): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }> {
	const registry = ctx.modelRegistry as unknown as {
		getApiKeyAndHeaders?: (
			model: Model<Api>,
		) => Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
		getApiKey?: (model: Model<Api>, sessionId?: string) => Promise<string | undefined>;
	};

	if (typeof registry.getApiKeyAndHeaders === "function") {
		return registry.getApiKeyAndHeaders(advisor);
	}
	if (typeof registry.getApiKey === "function") {
		const sessionId = ctx.sessionManager.getSessionId?.();
		const apiKey = await registry.getApiKey(advisor, sessionId ?? undefined);
		return { ok: true, apiKey };
	}
	return { ok: false, error: "Model registry does not expose an API-key resolver" };
}

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

export async function executeAdvisor(
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

	const auth = await getAdvisorAuth(ctx, advisor);
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
	const { messages: sessionMessages } = buildSessionContext(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getLeafId(),
	);
	const branchMessages = ensureUserTailForAdvisor(stripInflightAdvisorCall(convertToLlm(sessionMessages)));
	const inventoryMessage = getInventoryMessage(pi.getAllTools());
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
			// omp's Context.systemPrompt is string[]; upstream Pi typed it as a bare
			// string. We send an array (correct for the omp runtime this fork targets)
			// and cast so the upstream `string` type still checks.
			{ systemPrompt: [ADVISOR_SYSTEM_PROMPT] as unknown as string, messages, tools: [] },
			// `effort` is ThinkingLevel (minimal..xhigh, never "off"), which matches
			// omp's Effort enum values 1:1, so it passes through unchanged.
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
