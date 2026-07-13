/**
 * register — the advisor tool registration: zero-param schema, curated
 * description / promptSnippet / promptGuidelines, and an execute that delegates
 * to executeAdvisor. The guidance overrides are read from persisted config.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateGuidanceFields } from "@juicesharp/rpiv-config";
import { type Static, Type } from "typebox";
import { loadAdvisorConfig } from "./config.js";
import { type AdvisorCallParams, executeAdvisor } from "./execute.js";
import { ADVISOR_TOOL_NAME, buildChainSuffix, TOOL_LABEL } from "./messages.js";
import { findPerExecutorGuidance, MAX_CHAIN_DEPTH } from "./policy.js";

const AdvisorParams = Type.Object({
	depth: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_CHAIN_DEPTH,
			description: "Number of advisor tiers to walk along the configured chain (default: 1)",
		}),
	),
	target: Type.Optional(
		Type.String({
			description: "Walk the chain until this model name or provider:id key is reached (e.g. 'opus')",
		}),
	),
});

// Description when no chain is configured for the current executor — preserves
// the original "Takes NO parameters" wording so single-advisor UX is unchanged.
const ADVISOR_DESCRIPTION_NO_CHAIN =
	"Escalate to a stronger reviewer model for guidance. When you need " +
	"stronger judgment — a complex decision, an ambiguous failure, a problem " +
	"you're circling without progress — escalate to the advisor model for " +
	"guidance, then resume. Takes NO parameters — when you call advisor(), " +
	"your entire conversation history is automatically forwarded. The advisor " +
	"sees the task, every tool call you've made, every result you've seen.";

// Base description when a chain IS configured — omits "Takes NO parameters" and
// gets a chain suffix appended by buildAdvisorDescription.
const ADVISOR_DESCRIPTION_CHAIN_BASE =
	"Escalate to a stronger reviewer model for guidance. When you need " +
	"stronger judgment — a complex decision, an ambiguous failure, a problem " +
	"you're circling without progress — escalate to the advisor model for " +
	"guidance, then resume. Your entire conversation history is automatically " +
	"forwarded. The advisor sees the task, every tool call you've made, every " +
	"result you've seen.";

/**
 * Build the advisor tool description for the current executor. With no chain
 * labels, returns the static "Takes NO parameters" description. With chain
 * labels, returns the chain-aware base plus a suffix naming the chain and the
 * depth/target params.
 */
export function buildAdvisorDescription(chainLabels?: string[]): string {
	if (!chainLabels || chainLabels.length === 0) return ADVISOR_DESCRIPTION_NO_CHAIN;
	return ADVISOR_DESCRIPTION_CHAIN_BASE + buildChainSuffix(chainLabels);
}

// Tracks the description text of the last registration so refreshes can skip
// redundant re-registration (avoids tool-list churn).
let lastRegisteredDescription: string | undefined;
// Tracks the resolved-guidance fingerprint of the last registration so a
// per-executor guidance change (not just a description change) also triggers
// re-registration. Paired with lastRegisteredDescription in the refresh guard.
let lastRegisteredGuidanceKey: string | undefined;

/** Resolved guidance applied to the tool: concrete snippet + guidelines. */
interface ResolvedGuidance {
	promptSnippet: string;
	promptGuidelines: string[];
}

/**
 * Resolve the guidance for a given executor. Field-level merge with three
 * tiers, highest first: the executor's `perExecutorGuidance` override, the
 * global `guidance` config, then the built-in defaults. Each field resolves
 * independently, so a per-model block that sets only `promptGuidelines` still
 * inherits the global-or-default `promptSnippet`. With no executor key and no
 * config the defaults are returned by reference (guidance tests rely on this).
 */
function resolveExecutorGuidance(executorKey?: string): ResolvedGuidance {
	const global = validateGuidanceFields(loadAdvisorConfig().guidance);
	const perModel = findPerExecutorGuidance(executorKey);
	return {
		promptSnippet: perModel?.promptSnippet ?? global.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: perModel?.promptGuidelines ?? global.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
	};
}

/** Stable fingerprint of resolved guidance, used only for the refresh guard. */
function guidanceFingerprint(g: ResolvedGuidance): string {
	return JSON.stringify([g.promptSnippet, g.promptGuidelines]);
}

export const DEFAULT_PROMPT_SNIPPET =
	"Escalate to a stronger reviewer model for guidance when stuck, before substantive work, or before declaring done";

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Call `advisor` BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. Orientation (finding files, fetching a source, seeing what's there) is not substantive work; writing, editing, and declaring an answer are.",
	"Also call `advisor` when you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.",
	"Also call `advisor` when stuck — errors recurring, approach not converging, results that don't fit — or when considering a change of approach.",
	"On tasks longer than a few steps, call `advisor` at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling — the advisor adds most of its value on the first call, before the approach crystallizes.",
	"Give the advisor's advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim, adapt — a passing self-test is not evidence the advice is wrong, it's evidence your test doesn't check what the advice is checking.",
	"If you've already retrieved data pointing one way and the advisor points another, don't silently switch — surface the conflict in one more `advisor` call (\"I found X, you suggest Y, which constraint breaks the tie?\"). A reconcile call is cheaper than committing to the wrong branch.",
];

export function registerAdvisorTool(pi: ExtensionAPI, chainLabels?: string[], executorKey?: string): void {
	const guidance = resolveExecutorGuidance(executorKey);
	const description = buildAdvisorDescription(chainLabels);
	lastRegisteredDescription = description;
	lastRegisteredGuidanceKey = guidanceFingerprint(guidance);
	pi.registerTool({
		name: ADVISOR_TOOL_NAME,
		label: TOOL_LABEL,
		description,
		promptSnippet: guidance.promptSnippet,
		promptGuidelines: guidance.promptGuidelines,
		parameters: AdvisorParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeAdvisor(ctx, pi, signal, onUpdate, params as Static<typeof AdvisorParams> as AdvisorCallParams);
		},
	});
}

/**
 * Re-register the advisor tool only when its description would change for the
 * given chain labels. Re-registration updates the live tool definition in the
 * same session (the loader keys tools by name); the equality guard prevents
 * redundant churn when the chain topology is unchanged.
 *
 * Active-tool state is preserved across the re-registration: registering a tool
 * can re-add it to the active set, which would otherwise resurrect the advisor
 * tool after a blocked executor stripped it. Callers run reconcileAdvisorTool
 * first, so the active set is already correct. The restore only fires when
 * re-registration actually resurrected a stripped tool, so a refresh never
 * issues a spurious setActiveTools when the active set was already correct.
 */
export function refreshAdvisorToolDescription(pi: ExtensionAPI, chainLabels?: string[], executorKey?: string): void {
	const nextDescription = buildAdvisorDescription(chainLabels);
	const nextGuidanceKey = guidanceFingerprint(resolveExecutorGuidance(executorKey));
	if (nextDescription === lastRegisteredDescription && nextGuidanceKey === lastRegisteredGuidanceKey) return;
	const active = pi.getActiveTools();
	const wasActive = active.includes(ADVISOR_TOOL_NAME);
	registerAdvisorTool(pi, chainLabels, executorKey);
	if (!wasActive && pi.getActiveTools().includes(ADVISOR_TOOL_NAME)) {
		pi.setActiveTools(active);
	}
}
