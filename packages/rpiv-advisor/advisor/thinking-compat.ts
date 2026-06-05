/**
 * thinking-compat — the one thinking-levels API delta between upstream Pi and
 * the oh-my-pi (omp) fork.
 *
 * Upstream `@earendil-works/pi-ai` exports `getSupportedThinkingLevels(model)`.
 * omp renamed thinking-levels → "efforts" and exports `getSupportedEfforts(model)`
 * instead, dropping the old name. omp's extension loader rewrites this module's
 * `@earendil-works/pi-ai` import to omp's bundled pi-ai at load time, so at
 * runtime `PiAI.getSupportedEfforts` is present under omp and absent under
 * upstream Pi. We detect which one we're running against and reconstruct the
 * upstream contract either way, so this fork still runs its vitest suite against
 * the original deps while loading correctly inside omp.
 */

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import * as PiAI from "@earendil-works/pi-ai";

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

// Mirrors the upstream `getSupportedThinkingLevels` return type
// (`ModelThinkingLevel[]`, which includes "off") so call sites type-check
// identically against the installed @earendil-works/pi-ai types.
export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	// omp path: legacy remapper points this at omp's pi-ai, which exposes
	// getSupportedEfforts() (string-valued Effort enum → same level strings).
	const getSupportedEfforts = (
		PiAI as unknown as {
			getSupportedEfforts?: (model: Model<TApi>) => readonly unknown[];
		}
	).getSupportedEfforts;
	if (typeof getSupportedEfforts === "function") {
		return getSupportedEfforts(model).map((effort) => String(effort) as ModelThinkingLevel);
	}

	// upstream-Pi fallback: mirror the original getSupportedThinkingLevels logic
	// off `model.thinkingLevelMap` so the package still works against old deps.
	const thinkingLevelMap = (model as unknown as { thinkingLevelMap?: Record<string, unknown> }).thinkingLevelMap;
	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
}
