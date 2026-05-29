/**
 * config — persisted advisor config (~/.config/rpiv-advisor/advisor.json) and
 * the provider:id key codec. Owns the AdvisorConfig shape, load/validate/save,
 * and the modelKey (join) / parseModelKey (split) inverse pair (L4-04).
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { GuidanceFields } from "@juicesharp/rpiv-config";
import { configPath, loadJsonConfig, saveJsonConfig } from "@juicesharp/rpiv-config";
import { EFFORT_ORDINAL } from "./messages.js";

const ADVISOR_CONFIG_PATH = configPath("rpiv-advisor", "advisor.json");

export type DisabledForModelsEntry = string | { model: string; minEffort?: ThinkingLevel };

export interface PerExecutorEntry {
	/** Executor model key ("provider:id") this entry applies to. */
	executor: string;
	/** Advisor model key ("provider:id") to use when the executor matches. */
	advisor: string;
	/** Optional reasoning effort for the advisor side-call. Falls back to top-level `effort`. */
	effort?: ThinkingLevel;
}

interface AdvisorConfig {
	modelKey?: string;
	effort?: ThinkingLevel;
	guidance?: GuidanceFields;
	disabledForModels?: DisabledForModelsEntry[];
	perExecutor?: PerExecutorEntry[];
}

export function loadAdvisorConfig(): AdvisorConfig {
	return loadJsonConfig<AdvisorConfig>(ADVISOR_CONFIG_PATH);
}

export function validateDisabledForModels(value: unknown): DisabledForModelsEntry[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is DisabledForModelsEntry => {
		if (typeof entry === "string") return entry.length > 0;
		if (typeof entry !== "object" || entry === null) return false;
		const obj = entry as Record<string, unknown>;
		if (typeof obj.model !== "string" || obj.model.length === 0) return false;
		if (obj.minEffort !== undefined && !EFFORT_ORDINAL.includes(obj.minEffort as ThinkingLevel)) return false;
		return true;
	});
}

/**
 * Validate `perExecutor` entries from an unknown value.
 *
 * Each entry must be an object with non-empty string `executor` and `advisor`
 * fields and an optional `effort` from EFFORT_ORDINAL. Bad shapes are dropped
 * silently; valid entries preserve input order. Order matters: the resolver
 * picks the first matching entry, so configs can list more-specific entries
 * before fallbacks.
 */
export function validatePerExecutor(value: unknown): PerExecutorEntry[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is PerExecutorEntry => {
		if (!entry || typeof entry !== "object") return false;
		const obj = entry as Record<string, unknown>;
		if (typeof obj.executor !== "string" || obj.executor.length === 0) return false;
		if (typeof obj.advisor !== "string" || obj.advisor.length === 0) return false;
		if (obj.effort !== undefined && !EFFORT_ORDINAL.includes(obj.effort as ThinkingLevel)) return false;
		return true;
	});
}

export function saveAdvisorConfig(key: string | undefined, effort: ThinkingLevel | undefined): boolean {
	const existing = loadAdvisorConfig();
	const config: AdvisorConfig = { ...existing };
	// Delete (rather than omit) to clear fields that may exist in the spread
	// from a prior read. JSON.parse always produces configurable properties,
	// so delete is safe in strict mode.
	if (key) config.modelKey = key;
	else delete config.modelKey;
	if (effort) config.effort = effort;
	else delete config.effort;
	return saveJsonConfig(ADVISOR_CONFIG_PATH, config);
}

export function parseModelKey(key: string): { provider: string; modelId: string } | undefined {
	const idx = key.indexOf(":");
	if (idx < 1) return undefined;
	return { provider: key.slice(0, idx), modelId: key.slice(idx + 1) };
}

export function modelKey(m: { provider: string; id: string }): string {
	return `${m.provider}:${m.id}`;
}
