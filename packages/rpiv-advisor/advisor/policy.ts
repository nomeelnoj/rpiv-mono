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
import { type DisabledForModelsEntry, modelKey, type PerExecutorEntry } from "./config.js";
import { EFFORT_ORDINAL } from "./messages.js";

let disabledForModelsCache: DisabledForModelsEntry[] = [];
let perExecutorCache: PerExecutorEntry[] = [];

export function setDisabledForModels(models: DisabledForModelsEntry[]): void {
	disabledForModelsCache = models;
}

export function setPerExecutor(entries: PerExecutorEntry[]): void {
	perExecutorCache = entries;
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
