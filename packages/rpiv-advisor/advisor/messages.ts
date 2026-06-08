/**
 * messages — advisor vocabulary: tool identity, selector sentinels, effort
 * levels, UI labels, and every user-facing string (static + parameterized).
 * Pure declarations, no logic; consumed across the advisor/ modules.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";

// Scope sentinels for the /advisor scope picker
export const SCOPE_DEFAULT = "__scope_default__";
export const SCOPE_ROUTES = "__scope_routes__";

// Route CRUD sentinels
export const INHERIT_VALUE = "__inherit__";
export const ADD_ROUTE_VALUE = "__add_route__";
export const REMOVE_VALUE = "__remove_route__";
export const RESET_ALL_ROUTES_VALUE = "__reset_all_routes__";
export const CONFIRM_RESET_VALUE = "__confirm_reset__";

// Tool identity
export const ADVISOR_TOOL_NAME = "advisor";
export const TOOL_LABEL = "Advisor";

// Selector sentinels — double-underscore form is collision-proof against real provider:id keys
export const NO_ADVISOR_VALUE = "__no_advisor__";
export const OFF_VALUE = "__off__";

// Effort levels
export const BASE_EFFORT_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high"];
export const XHIGH_EFFORT_LEVEL: ThinkingLevel = "xhigh";
export const EFFORT_ORDINAL: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];
export const DEFAULT_EFFORT: ThinkingLevel = "high";
export const RECOMMENDED_EFFORT_SUFFIX = "  (recommended)";

// UI — labels used by command flow; panel prose/titles live in advisor-ui.ts
export const CHECKMARK = " ✓";

// Messages (static)
export const MSG_ADVISOR_DISABLED = "Advisor disabled";
export const MSG_REQUIRES_INTERACTIVE = "/advisor requires interactive mode";
export const MSG_ADVISOR_NUDGE = "Please advise on the executor's situation above.";
export const MSG_PERSIST_FAILED = "Failed to save advisor selection — selection not persisted";

// Errors (static)
export const ERR_NO_MODEL = "No advisor model is configured. The user can enable one with the /advisor command.";
export const ERR_CALL_ABORTED = "Advisor call was cancelled before it completed.";
export const ERR_EMPTY_RESPONSE = "Advisor returned no text content.";
export const ERR_NO_MODEL_SELECTED = "no advisor model selected";
export const ERR_EMPTY_RESPONSE_DETAIL = "empty response";
export const ERR_ABORTED_DETAIL = "aborted";
export const ERR_UNKNOWN = "unknown error";

// Errors/messages (parameterized)
export const errMisconfigured = (label: string, err: string) => `Advisor (${label}) is misconfigured: ${err}`;
export const errNoApiKey = (label: string) => `Advisor (${label}) has no API key available.`;
export const errNoApiKeyDetail = (provider: string) => `no API key for ${provider}`;
export const errCallFailed = (err: string | undefined) => `Advisor call failed: ${err ?? ERR_UNKNOWN}`;
export const errCallThrew = (msg: string) => `Advisor call threw: ${msg}`;
export const errSelectionNotFound = (choice: string) => `Advisor selection not found: ${choice}`;
export const errModelUnavailable = (key: string) => `Previously configured advisor model ${key} is no longer available`;
export const msgAdvisorEnabled = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor: ${label}${effort ? `, ${effort}` : ""}`;
export const msgAdvisorRestored = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor restored: ${label}${effort ? `, ${effort}` : ""}`;
export const msgAdvisorRestoredInactive = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor restored: ${label}${effort ? `, ${effort}` : ""} (inactive for current executor)`;
export const msgAdvisorEnabledInactive = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor: ${label}${effort ? `, ${effort}` : ""} (inactive for current executor)`;
export const msgRouteSaved = (executor: string, advisor: string, effort: ThinkingLevel | undefined) =>
	`Route saved: ${executor} → ${advisor}${effort ? `, ${effort}` : " (inherit)"}` as string;
export const msgRouteRemoved = (executor: string) => `Route removed: ${executor}`;
export const MSG_ROUTES_RESET = "All per-executor routes cleared";

export const msgConsulting = (label: string, effort: ThinkingLevel | undefined) =>
	`Consulting advisor (${label}${effort ? `, ${effort}` : ""})…`;

// ── Chain walking ─────────────────────────────────────────────────────────────
// The advisor tool can walk a chain of advisors implied by the perExecutor
// routing table (each model's `advisor` entry is the next node). These strings
// build the dynamic tool-description suffix, the per-tier prior-response context
// message, and the cycle-termination warning.

// Intro line for the synthetic user message that threads prior advisor responses
// into deeper-tier calls.
export const ADVISOR_CHAIN_PRIOR_INTRO = "Prior advisor responses in this escalation chain:";

// One prior-response block: `[Advisor 2 — provider:id]\n{text}`.
export const formatPriorAdvisorResponse = (index: number, label: string, text: string) =>
	`[Advisor ${index} — ${label}]\n${text}`;

// Dynamic description suffix appended when a chain exists for the current
// executor. Empty string when there is no chain (caller omits it).
export const buildChainSuffix = (chainLabels: string[]): string => {
	if (chainLabels.length === 0) return "";
	const last = chainLabels[chainLabels.length - 1];
	const first = chainLabels[0];
	return (
		` Chain available from current executor: ${chainLabels.join(" → ")}.` +
		` Pass depth (e.g. depth:2) to walk N tiers, or target (e.g. target:"${last}")` +
		` to walk until a specific model. Default: depth 1 (one hop to ${first}).`
	);
};

// Cycle-termination warning — logged (not surfaced to the executor) when a model
// key would be revisited during the walk.
export const warnChainCycle = (keys: string[]) =>
	`Advisor chain cycle detected; stopping before revisit: ${keys.join(" → ")}`;
