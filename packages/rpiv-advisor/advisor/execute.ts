/**
 * execute — the advisor side-call. Curates the executor's branch (inventory
 * prefix + tail massaging), invokes the advisor model via completeSimple with
 * no tools, and returns a structured tool result. Every result branch (success
 * / abort / error / empty) and the pre-call error paths funnel through
 * buildAdvisorResult so the envelope is built in exactly one place.
 *
 * Per-executor fallback: when the routed advisor is a `perExecutor` override and
 * its attempt fails hard (auth failure, an `error` stop reason such as a
 * provider content filter, or a thrown exception), the call is retried once
 * with the default advisor. See executeAdvisor for the exact policy.
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
import { modelKey, parseModelKey } from "./config.js";
import { ensureUserTailForAdvisor, flattenToolBlocksForAdvisor, stripInflightAdvisorCall } from "./context.js";
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

interface ResolvedAdvisor {
	advisor: Model<Api> | undefined;
	effort: ThinkingLevel | undefined;
	/** True when the resolved advisor came from a matched perExecutor override. */
	isOverride: boolean;
}

/**
 * Resolve the advisor model + effort for this call.
 *
 * If the executor (`ctx.model`) matches a `perExecutor` entry AND the override's
 * advisor key resolves in the model registry, the override wins (`isOverride`).
 * Otherwise fall back to the default advisor (`getAdvisorModel`/`getAdvisorEffort`).
 *
 * Registry-miss fallback is silent: the advisor call is hot-path and the
 * default model is already user-selected, so a missing override model is best
 * handled by quietly using the default rather than failing the call.
 *
 * Disable-wins: callers strip the advisor tool when `isExecutorBlocked` returns
 * true, so this resolver never sees blocked executors during normal flow.
 */
function resolveAdvisor(ctx: ExtensionContext): ResolvedAdvisor {
	const override = findPerExecutorOverride(ctx.model);
	if (override) {
		const parsed = parseModelKey(override.advisor);
		const overrideModel = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
		if (overrideModel) {
			return { advisor: overrideModel, effort: override.effort ?? getAdvisorEffort(), isOverride: true };
		}
	}
	return { advisor: getAdvisorModel(), effort: getAdvisorEffort(), isOverride: false };
}

interface AdvisorDetails {
	advisorModel?: string;
	effort?: ThinkingLevel;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	/** Set on a fallback result: the override "provider:id" whose attempt failed. */
	fallbackFrom?: string;
	/** Set on a fallback result: the failed override's error message, for observability. */
	fallbackReason?: string;
}

// Single result-envelope builder — every attemptAdvisorCall branch and the
// pre-call error paths funnel through here. `effort` is snapshotted once at
// executeAdvisor entry and threaded through every call so the returned
// details.effort always matches the value sent as `reasoning` to completeSimple,
// even if module-level state is mutated during the await window.
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

// Build the advisor-facing message array once per tool call. It is
// advisor-independent (identical for the primary attempt and any fallback), so
// it is built before dispatch and reused across attempts. See context.ts for
// the curation steps (in-flight advisor-call strip, tool-block flattening,
// user-tail guarantee) and inventory.ts for the tool-inventory prefix.
function buildAdvisorMessages(ctx: ExtensionContext, pi: ExtensionAPI): Message[] {
	const { messages: sessionMessages } = buildSessionContext(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getLeafId(),
	);
	const branchMessages = ensureUserTailForAdvisor(
		flattenToolBlocksForAdvisor(stripInflightAdvisorCall(convertToLlm(sessionMessages))),
	);
	const inventoryMessage = getInventoryMessage(pi.getAllTools());
	return inventoryMessage ? [inventoryMessage, ...branchMessages] : branchMessages;
}

// A single advisor attempt against one model: auth preflight → completeSimple →
// classified envelope. `failed` is true only for hard failures a fallback
// should retry past — auth misconfiguration, missing auth, an `error` stop
// reason (which includes provider content filters), or a thrown exception. A
// user abort or an empty response is terminal (`failed: false`): an abort is the
// user's intent and an empty response is a real (if unhelpful) answer, so
// neither should trigger a fallback.
async function attemptAdvisorCall(
	ctx: ExtensionContext,
	advisor: Model<Api>,
	effort: ThinkingLevel | undefined,
	messages: Message[],
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
): Promise<{ result: AgentToolResult<AdvisorDetails>; failed: boolean }> {
	const advisorLabel = `${advisor.provider}:${advisor.id}`;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisor);
	if (!auth.ok) {
		return {
			failed: true,
			result: buildErrorResult(advisorLabel, effort, errMisconfigured(advisorLabel, auth.error), auth.error),
		};
	}
	if (!auth.apiKey && !ctx.modelRegistry.getProviderAuthStatus(advisor.provider).configured) {
		// A missing apiKey is only fatal when the provider has no configured auth
		// at all — credential-chain providers (e.g. Amazon Bedrock via an AWS
		// profile/SSO/role) authenticate without an explicit key.
		return {
			failed: true,
			result: buildErrorResult(advisorLabel, effort, errNoApiKey(advisorLabel), errNoApiKeyDetail(advisor.provider)),
		};
	}

	onUpdate?.({
		content: [{ type: "text", text: msgConsulting(advisorLabel, effort) }],
		details: { advisorModel: advisorLabel, effort },
	});

	try {
		const response = await completeSimple(
			advisor,
			// `tools: []` reaffirms the "never calls tools" contract. The branch's
			// toolCall/toolResult blocks have already been flattened to text by
			// flattenToolBlocksForAdvisor, so no provider (notably Bedrock Converse,
			// which requires toolConfig alongside tool blocks) sees tool blocks
			// without an accompanying tool list.
			{ systemPrompt: ADVISOR_SYSTEM_PROMPT, messages, tools: [] },
			{ apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: effort },
		);

		if (response.stopReason === "aborted") {
			return {
				failed: false,
				result: buildAdvisorResult({
					text: ERR_CALL_ABORTED,
					effort,
					advisorLabel,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage ?? ERR_ABORTED_DETAIL,
				}),
			};
		}

		if (response.stopReason === "error") {
			return {
				failed: true,
				result: buildAdvisorResult({
					text: errCallFailed(response.errorMessage),
					effort,
					advisorLabel,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage,
				}),
			};
		}

		const advisorText = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (!advisorText) {
			return {
				failed: false,
				result: buildAdvisorResult({
					text: ERR_EMPTY_RESPONSE,
					effort,
					advisorLabel,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: ERR_EMPTY_RESPONSE_DETAIL,
				}),
			};
		}

		return {
			failed: false,
			result: buildAdvisorResult({
				text: advisorText,
				effort,
				advisorLabel,
				usage: response.usage,
				stopReason: response.stopReason,
			}),
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { failed: true, result: buildErrorResult(advisorLabel, effort, errCallThrew(message), message) };
	}
}

export async function executeAdvisor(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
): Promise<AgentToolResult<AdvisorDetails>> {
	// Snapshot the routed advisor once at entry — resolveAdvisor consults the
	// perExecutor routing table first and falls back to the default selection on
	// miss. Snapshotting avoids desync if module-level state mutates during an
	// await window.
	const primary = resolveAdvisor(ctx);
	if (!primary.advisor) {
		return buildErrorResult(undefined, primary.effort, ERR_NO_MODEL, ERR_NO_MODEL_SELECTED);
	}

	// Advisor-independent; built once and reused by the primary and fallback.
	const messages = buildAdvisorMessages(ctx, pi);

	const first = await attemptAdvisorCall(ctx, primary.advisor, primary.effort, messages, signal, onUpdate);
	if (!first.failed) {
		return first.result;
	}

	// Per-executor fallback: when the failed attempt used an override, retry once
	// with the default advisor. Only meaningful when a default is configured and
	// resolves to a different model than the override — otherwise the retry would
	// just reproduce the same failure. A non-override failure has nothing to fall
	// back to (the default advisor is already what ran), so it returns as-is.
	if (primary.isOverride) {
		const fallbackAdvisor = getAdvisorModel();
		if (fallbackAdvisor && modelKey(fallbackAdvisor) !== modelKey(primary.advisor)) {
			const second = await attemptAdvisorCall(ctx, fallbackAdvisor, getAdvisorEffort(), messages, signal, onUpdate);
			// Annotate the fallback envelope so callers can see the override was
			// skipped and why, without polluting the advice text itself.
			if (second.result.details) {
				second.result.details.fallbackFrom = modelKey(primary.advisor);
				second.result.details.fallbackReason = first.result.details?.errorMessage;
			}
			return second.result;
		}
	}

	return first.result;
}
