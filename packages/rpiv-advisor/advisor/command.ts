/**
 * command — the /advisor slash command. Reads top-down: interactive guard →
 * scope picker (Default advisor | Per-executor routes) → Default branch:
 * model picker → no-advisor → effort picker → applyEnable/applyDisable.
 * Routes branch: list routes → add / edit / remove / reset. The apply helpers
 * and route save helpers persist before mutating in-memory state (review I2).
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import {
	showAdvisorPicker,
	showEffortPicker,
	showRouteActionPicker,
	showRouteAdvisorPicker,
	showRouteEffortPicker,
	showRouteExecutorPicker,
	showRouteListPicker,
	showScopePicker,
} from "../advisor-ui.js";
import { loadAdvisorConfig, modelKey, type PerExecutorEntry, saveAdvisorConfig, savePerExecutor } from "./config.js";
import { reconcileAdvisorTool } from "./handlers.js";
import {
	ADD_ROUTE_VALUE,
	ADVISOR_TOOL_NAME,
	BASE_EFFORT_LEVELS,
	CHECKMARK,
	CONFIRM_RESET_VALUE,
	DEFAULT_EFFORT,
	errSelectionNotFound,
	INHERIT_VALUE,
	MSG_ADVISOR_DISABLED,
	MSG_PERSIST_FAILED,
	MSG_REQUIRES_INTERACTIVE,
	MSG_ROUTES_RESET,
	msgAdvisorEnabled,
	msgAdvisorEnabledInactive,
	msgRouteRemoved,
	msgRouteSaved,
	NO_ADVISOR_VALUE,
	OFF_VALUE,
	RECOMMENDED_EFFORT_SUFFIX,
	REMOVE_VALUE,
	RESET_ALL_ROUTES_VALUE,
	SCOPE_DEFAULT,
	SCOPE_ROUTES,
	XHIGH_EFFORT_LEVEL,
} from "./messages.js";
import { isExecutorBlocked, resolveChainLabels, setPerExecutor } from "./policy.js";
import { refreshAdvisorToolDescription } from "./register.js";
import { getAdvisorEffort, getAdvisorModel, setAdvisorEffort, setAdvisorModel } from "./state.js";

// ── Item builders ─────────────────────────────────────────────────────────────

function buildScopeItems(): SelectItem[] {
	return [
		{ value: SCOPE_DEFAULT, label: "Default advisor" },
		{ value: SCOPE_ROUTES, label: "Per-executor routes" },
	];
}

function buildModelItems(availableModels: Model<Api>[], currentKey: string | undefined): SelectItem[] {
	const items: SelectItem[] = availableModels.map((m) => {
		const key = modelKey(m);
		const check = key === currentKey ? CHECKMARK : "";
		return { value: key, label: `${m.name}  (${m.provider})${check}` };
	});
	items.push({
		value: NO_ADVISOR_VALUE,
		label: currentKey === undefined ? `No advisor${CHECKMARK}` : "No advisor",
	});
	return items;
}

/**
 * Like buildModelItems but without the "No advisor" sentinel — used by the
 * per-executor route pickers where every item is a real model.
 */
function buildRoutingModelItems(availableModels: Model<Api>[], currentKey?: string): SelectItem[] {
	return availableModels.map((m) => {
		const key = modelKey(m);
		const check = key === currentKey ? CHECKMARK : "";
		return { value: key, label: `${m.name}  (${m.provider})${check}` };
	});
}

function buildEffortItems(picked: Model<Api>): SelectItem[] {
	const levels = getSupportedThinkingLevels(picked).includes("xhigh")
		? [...BASE_EFFORT_LEVELS, XHIGH_EFFORT_LEVEL]
		: BASE_EFFORT_LEVELS;
	return [
		{ value: OFF_VALUE, label: "off" },
		...levels.map((level) => ({
			value: level,
			label: level === DEFAULT_EFFORT ? `${level}${RECOMMENDED_EFFORT_SUFFIX}` : level,
		})),
	];
}

/**
 * Route effort items: `inherit (use default)` + graded levels. No `off`
 * sentinel — `off` is not in EFFORT_ORDINAL and would be silently dropped on
 * the next config load. `INHERIT_VALUE` maps to `effort: undefined` on the
 * entry (resolver falls back to top-level effort).
 */
function buildRouteEffortItems(advisorModel: Model<Api>): SelectItem[] {
	const levels = getSupportedThinkingLevels(advisorModel).includes("xhigh")
		? [...BASE_EFFORT_LEVELS, XHIGH_EFFORT_LEVEL]
		: BASE_EFFORT_LEVELS;
	return [
		{ value: INHERIT_VALUE, label: "inherit (use default)" },
		...levels.map((level) => ({
			value: level,
			label: level === DEFAULT_EFFORT ? `${level}${RECOMMENDED_EFFORT_SUFFIX}` : level,
		})),
	];
}

/**
 * Build the route-list items from the saved config (not filtered by model
 * availability) so existing routes for unavailable models can still be listed
 * and removed.
 */
function buildRouteListItems(routes: PerExecutorEntry[]): SelectItem[] {
	const items: SelectItem[] = routes.map((r) => ({
		value: r.executor,
		label: `${r.executor} \u2192 ${r.advisor}  [${r.effort ?? "inherit"}]${CHECKMARK}`,
	}));
	items.push({ value: ADD_ROUTE_VALUE, label: "Add route" });
	items.push({ value: RESET_ALL_ROUTES_VALUE, label: "Reset all routes" });
	return items;
}

/**
 * After a route table mutation, re-sync the advisor tool description so a chain
 * involving the current executor is reflected immediately (not just on the next
 * model_select). Guarded against redundant re-registration inside the refresh.
 */
function refreshRoutesDescription(pi: ExtensionAPI, ctx: ExtensionContext): void {
	refreshAdvisorToolDescription(
		pi,
		resolveChainLabels(ctx.model, ctx.modelRegistry),
		ctx.model ? modelKey(ctx.model) : undefined,
	);
}

/** Upsert by executor key — replace in place when found, append otherwise. */
function upsertRoute(routes: PerExecutorEntry[], entry: PerExecutorEntry): PerExecutorEntry[] {
	const idx = routes.findIndex((r) => r.executor === entry.executor);
	if (idx >= 0) {
		const copy = [...routes];
		copy[idx] = entry;
		return copy;
	}
	return [...routes, entry];
}

// ── Apply helpers (default advisor) ──────────────────────────────────────────

// Disable path — persist BEFORE mutating in-memory state so a save failure
// can't strand "model=undefined + tool still registered" (review I2).
function applyDisable(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!saveAdvisorConfig(undefined, undefined)) {
		ctx.ui.notify(MSG_PERSIST_FAILED, "error");
		return;
	}
	setAdvisorModel(undefined);
	setAdvisorEffort(undefined);
	const active = pi.getActiveTools();
	if (active.includes(ADVISOR_TOOL_NAME)) {
		pi.setActiveTools(active.filter((n) => n !== ADVISOR_TOOL_NAME));
	}
	ctx.ui.notify(MSG_ADVISOR_DISABLED, "info");
}

// Enable path — persist first (review I2), set in-memory state, activate via
// reconcileAdvisorTool, and notify.
function applyEnable(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	picked: Model<Api>,
	effort: ThinkingLevel | undefined,
): void {
	if (!saveAdvisorConfig(modelKey(picked), effort)) {
		ctx.ui.notify(MSG_PERSIST_FAILED, "error");
		return;
	}
	setAdvisorEffort(effort);
	setAdvisorModel(picked);

	const blocked = isExecutorBlocked(ctx, pi.getThinkingLevel());
	reconcileAdvisorTool(pi, ctx, { blocked });
	ctx.ui.notify(
		blocked ? msgAdvisorEnabledInactive(modelKey(picked), effort) : msgAdvisorEnabled(modelKey(picked), effort),
		"info",
	);
}

// ── Default advisor flow ──────────────────────────────────────────────────────

async function configureDefaultAdvisor(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const availableModels = ctx.modelRegistry.getAvailable();
	const current = getAdvisorModel();
	const currentKey = current ? modelKey(current) : undefined;

	const choice = await showAdvisorPicker(ctx, buildModelItems(availableModels, currentKey));
	if (!choice) return;

	if (choice === NO_ADVISOR_VALUE) {
		applyDisable(pi, ctx);
		return;
	}

	const picked = availableModels.find((m) => modelKey(m) === choice);
	if (!picked) {
		ctx.ui.notify(errSelectionNotFound(choice), "error");
		return;
	}

	// Effort picker — only for reasoning-capable models
	let effortChoice: ThinkingLevel | undefined;
	if (picked.reasoning) {
		const effortResult = await showEffortPicker(ctx, buildEffortItems(picked), getAdvisorEffort(), DEFAULT_EFFORT);
		if (!effortResult) return;
		effortChoice = effortResult === OFF_VALUE ? undefined : (effortResult as ThinkingLevel);
	}

	applyEnable(pi, ctx, picked, effortChoice);
}

// ── Routes flow ───────────────────────────────────────────────────────────────

/**
 * Add a new route or edit an existing one (executor → advisor → effort →
 * save). Upserts by executor key: replaces in place when the executor already
 * has an entry, appends otherwise. Persist-before-mutate: setPerExecutor is
 * called only after savePerExecutor succeeds (review I2).
 */
async function addOrEditRoute(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	allRoutes: PerExecutorEntry[],
	availableModels: Model<Api>[],
	existingEntry?: PerExecutorEntry,
): Promise<void> {
	// Step 1: executor picker
	const executorItems = buildRoutingModelItems(availableModels, existingEntry?.executor);
	const executorChoice = await showRouteExecutorPicker(ctx, executorItems);
	if (!executorChoice) return;

	// Step 2: advisor picker
	const advisorItems = buildRoutingModelItems(availableModels, existingEntry?.advisor);
	const advisorChoice = await showRouteAdvisorPicker(ctx, advisorItems);
	if (!advisorChoice) return;

	const advisorModel = availableModels.find((m) => modelKey(m) === advisorChoice);
	if (!advisorModel) {
		ctx.ui.notify(errSelectionNotFound(advisorChoice), "error");
		return;
	}

	// Step 3: route effort picker (reasoning advisor models only)
	let effortChoice: ThinkingLevel | undefined;
	if (advisorModel.reasoning) {
		const routeEffortItems = buildRouteEffortItems(advisorModel);
		const preferredValue = existingEntry?.effort ?? INHERIT_VALUE;
		const effortResult = await showRouteEffortPicker(ctx, routeEffortItems, preferredValue);
		if (!effortResult) return;
		// INHERIT_VALUE → omit effort (fall back to top-level effort in resolver)
		effortChoice = effortResult !== INHERIT_VALUE ? (effortResult as ThinkingLevel) : undefined;
	}

	const newEntry: PerExecutorEntry = {
		executor: executorChoice,
		advisor: advisorChoice,
		...(effortChoice !== undefined ? { effort: effortChoice } : {}),
	};

	const newRoutes = upsertRoute(allRoutes, newEntry);
	if (!savePerExecutor(newRoutes)) {
		ctx.ui.notify(MSG_PERSIST_FAILED, "error");
		return;
	}
	setPerExecutor(newRoutes);
	refreshRoutesDescription(pi, ctx);
	ctx.ui.notify(msgRouteSaved(executorChoice, advisorChoice, effortChoice), "info");
}

async function editOrRemoveRoute(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	allRoutes: PerExecutorEntry[],
	selected: PerExecutorEntry,
	availableModels: Model<Api>[],
): Promise<void> {
	const actionItems: SelectItem[] = [
		{ value: "edit", label: "Edit route" },
		{ value: REMOVE_VALUE, label: "Remove route" },
	];

	const action = await showRouteActionPicker(ctx, actionItems);
	if (!action) return;

	if (action === REMOVE_VALUE) {
		const newRoutes = allRoutes.filter((r) => r.executor !== selected.executor);
		if (!savePerExecutor(newRoutes)) {
			ctx.ui.notify(MSG_PERSIST_FAILED, "error");
			return;
		}
		setPerExecutor(newRoutes);
		refreshRoutesDescription(pi, ctx);
		ctx.ui.notify(msgRouteRemoved(selected.executor), "info");
		return;
	}

	// action === "edit": re-run the full flow with existing entry pre-selected
	await addOrEditRoute(pi, ctx, allRoutes, availableModels, selected);
}

async function resetAllRoutes(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	existingRoutes: PerExecutorEntry[],
): Promise<void> {
	// Nothing to reset — skip confirm step
	if (existingRoutes.length === 0) return;

	const confirmItems: SelectItem[] = [
		{ value: CONFIRM_RESET_VALUE, label: "Yes, clear all routes" },
		{ value: "cancel", label: "Cancel" },
	];

	const confirm = await showRouteActionPicker(ctx, confirmItems);
	if (confirm !== CONFIRM_RESET_VALUE) return;

	if (!savePerExecutor([])) {
		ctx.ui.notify(MSG_PERSIST_FAILED, "error");
		return;
	}
	setPerExecutor([]);
	refreshRoutesDescription(pi, ctx);
	ctx.ui.notify(MSG_ROUTES_RESET, "info");
}

async function manageRoutes(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const availableModels = ctx.modelRegistry.getAvailable();
	const { perExecutor: existingRoutes = [] } = loadAdvisorConfig();

	const choice = await showRouteListPicker(ctx, buildRouteListItems(existingRoutes));
	if (!choice) return;

	if (choice === ADD_ROUTE_VALUE) {
		await addOrEditRoute(pi, ctx, existingRoutes, availableModels);
		return;
	}

	if (choice === RESET_ALL_ROUTES_VALUE) {
		await resetAllRoutes(pi, ctx, existingRoutes);
		return;
	}

	const selectedRoute = existingRoutes.find((r) => r.executor === choice);
	if (!selectedRoute) {
		ctx.ui.notify(errSelectionNotFound(choice), "error");
		return;
	}

	await editOrRemoveRoute(pi, ctx, existingRoutes, selectedRoute, availableModels);
}

// ── Main command registration ─────────────────────────────────────────────────

export function registerAdvisorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("advisor", {
		description: "Configure the advisor model for the advisor-strategy pattern",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
				return;
			}

			const scopeChoice = await showScopePicker(ctx, buildScopeItems());
			if (!scopeChoice) return;

			if (scopeChoice === SCOPE_DEFAULT) {
				await configureDefaultAdvisor(pi, ctx);
				return;
			}

			if (scopeChoice === SCOPE_ROUTES) {
				await manageRoutes(pi, ctx);
			}
		},
	});
}
