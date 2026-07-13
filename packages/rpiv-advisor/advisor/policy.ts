/**
 * policy — the disabledForModels blocklist + perExecutor routing table
 * (caches + setters) and the predicates/resolvers that decide whether the
 * advisor tool is blocked for a given model/effort and which advisor model
 * an executor should escalate to.
 *
 * Disable wins over routing: if both apply to the same executor, the tool is
 * stripped (callers should branch on `isExecutorBlocked` first). The resolver
 * never reads `disabledForModelsCache` — the calling code already did.
 */

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GuidanceFields } from "@juicesharp/rpiv-config";
import {
	type DisabledForModelsEntry,
	modelKey,
	type PerExecutorEntry,
	type PerExecutorGuidanceEntry,
	parseModelKey,
} from "./config.js";
import { EFFORT_ORDINAL, warnChainCycle } from "./messages.js";

/** Hard cap on chain length — a safety rail, mirrored by the tool schema's `maximum`. */
export const MAX_CHAIN_DEPTH = 10;

/** One resolved hop in an advisor chain: the next advisor model + its optional effort override. */
export interface ChainNode {
	model: Model<Api>;
	effort?: ThinkingLevel;
}

/** Minimal model-registry surface needed to resolve chain hops (matches `ctx.modelRegistry`). */
interface ModelFinder {
	find(provider: string, id: string): Model<Api> | undefined;
}

let disabledForModelsCache: DisabledForModelsEntry[] = [];
let perExecutorCache: PerExecutorEntry[] = [];
let perExecutorGuidanceCache: PerExecutorGuidanceEntry[] = [];

export function setDisabledForModels(models: DisabledForModelsEntry[]): void {
	disabledForModelsCache = models;
}

export function setPerExecutor(entries: PerExecutorEntry[]): void {
	perExecutorCache = entries;
}

export function setPerExecutorGuidance(entries: PerExecutorGuidanceEntry[]): void {
	perExecutorGuidanceCache = entries;
}

/**
 * Find the guidance override for an executor model key. Returns the `guidance`
 * of the first `perExecutorGuidance` entry whose `models` list includes the
 * key, or undefined when there is no key or no match. Callers merge this over
 * the global guidance field-by-field, so a partial override (e.g. only
 * `promptGuidelines`) leaves the other field falling through to global/default.
 */
export function findPerExecutorGuidance(executorKey: string | undefined): GuidanceFields | undefined {
	if (!executorKey) return undefined;
	return perExecutorGuidanceCache.find((entry) => entry.models.includes(executorKey))?.guidance;
}

/**
 * Find the first `perExecutor` entry whose `executor` matches the given
 * model's "provider:id" key. Returns the matched entry verbatim — callers
 * decide whether to honor `entry.effort` or fall back to top-level effort.
 * Returns undefined when there is no executor model or no match.
 */
export function findPerExecutorOverride(executor: Model<Api> | undefined): PerExecutorEntry | undefined {
	if (!executor) return undefined;
	const key = modelKey(executor);
	return perExecutorCache.find((entry) => entry.executor === key);
}

/**
 * Walk the chain implied by the perExecutor routing table starting from
 * `executor`. Each hop resolves the current model's `advisor` entry and looks
 * the next model up in the registry. The walk stops when: the depth cap is
 * reached, the current model has no perExecutor entry, the next advisor key
 * is not in the registry, the target matches, or a model key would be revisited
 * (cycle). Returns the resolved hops in order (may be empty).
 *
 * `warnOnCycle` is true only for execution resolution — the description-label
 * refresh re-walks the same table and must not spam warnings.
 */
function walkChainNodes(
	executor: Model<Api> | undefined,
	depth: number,
	target: string | undefined,
	registry: ModelFinder,
	warnOnCycle: boolean,
): ChainNode[] {
	if (!executor) return [];
	const nodes: ChainNode[] = [];
	const visited = new Set<string>([modelKey(executor)]);
	const limit = Math.min(MAX_CHAIN_DEPTH, Math.max(1, depth));
	let current: Model<Api> = executor;
	for (let i = 0; i < limit; i++) {
		const entry = findPerExecutorOverride(current);
		if (!entry) break;
		const parsed = parseModelKey(entry.advisor);
		const next = parsed ? registry.find(parsed.provider, parsed.modelId) : undefined;
		if (!next) break;
		const nextKey = modelKey(next);
		if (visited.has(nextKey)) {
			if (warnOnCycle) console.warn(warnChainCycle([...visited, nextKey]));
			break;
		}
		nodes.push({ model: next, effort: entry.effort });
		visited.add(nextKey);
		if (target && matchesTarget(next, target)) break;
		current = next;
	}
	return nodes;
}

/**
 * Target matching: a full colon-form key (`provider:id`) equality OR a
 * case-insensitive partial match against the model's display name. The first
 * walk node that satisfies either is the target.
 */
function matchesTarget(model: Model<Api>, target: string): boolean {
	if (modelKey(model) === target) return true;
	const name = model.name ?? "";
	return name.toLowerCase().includes(target.toLowerCase());
}

/**
 * Resolve the advisor chain for an executor up to `depth` hops, stopping early
 * on `target` match. Warns and terminates on cycles. Used by the chain-walk
 * execution path; an empty result means the caller should fall back to the
 * single-hop advisor path.
 */
export function resolveAdvisorChain(
	executor: Model<Api> | undefined,
	depth: number,
	target: string | undefined,
	registry: ModelFinder,
): ChainNode[] {
	return walkChainNodes(executor, depth, target, registry, true);
}

/**
 * Resolve the full chain display labels for the current executor (model names
 * in walk order). Used to build the dynamic tool-description suffix. Walks the
 * full depth with no target and never warns on cycles.
 */
export function resolveChainLabels(executor: Model<Api> | undefined, registry: ModelFinder): string[] {
	return walkChainNodes(executor, MAX_CHAIN_DEPTH, undefined, registry, false).map(
		(n) => n.model.name ?? modelKey(n.model),
	);
}

export function isModelBlocked(model: Model<Api> | undefined, thinkingLevel?: string): boolean {
	if (!model) return false;
	const key = modelKey(model);
	for (const entry of disabledForModelsCache) {
		if (typeof entry === "string") {
			if (entry === key) return true;
		} else {
			if (entry.model !== key) continue;
			if (entry.minEffort === undefined) return true;
			const thresholdOrdinal = EFFORT_ORDINAL.indexOf(entry.minEffort);
			const executorOrdinal = EFFORT_ORDINAL.indexOf(thinkingLevel as ThinkingLevel);
			if (executorOrdinal >= thresholdOrdinal) return true;
		}
	}
	return false;
}

export function isExecutorBlocked(ctx: ExtensionContext, thinkingLevel?: string): boolean {
	return isModelBlocked(ctx?.model, thinkingLevel);
}
