import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import { setDisabledForModels } from "./advisor/index.js";
import { isModelBlocked } from "./advisor/policy.js";

const opus = { provider: "anthropic", id: "opus", name: "Opus" } as unknown as Model<Api>;
const sonnet = { provider: "anthropic", id: "sonnet", name: "Sonnet" } as unknown as Model<Api>;

beforeEach(() => {
	setDisabledForModels([]);
});

describe("isModelBlocked", () => {
	it("returns false when model is undefined", () => {
		setDisabledForModels(["anthropic:sonnet"]);
		expect(isModelBlocked(undefined)).toBe(false);
	});

	it("returns false when blocklist is empty", () => {
		expect(isModelBlocked(sonnet)).toBe(false);
	});

	it("returns true on string entry exact match", () => {
		setDisabledForModels(["anthropic:sonnet"]);
		expect(isModelBlocked(sonnet)).toBe(true);
	});

	it("returns false on string entry non-match", () => {
		setDisabledForModels(["anthropic:sonnet"]);
		expect(isModelBlocked(opus)).toBe(false);
	});

	it("returns true on object entry without minEffort (always blocked)", () => {
		setDisabledForModels([{ model: "anthropic:sonnet" }]);
		expect(isModelBlocked(sonnet)).toBe(true);
		expect(isModelBlocked(sonnet, "minimal")).toBe(true);
		expect(isModelBlocked(sonnet, "xhigh")).toBe(true);
	});

	it("returns false on object entry when model key does not match", () => {
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "low" }]);
		expect(isModelBlocked(opus, "high")).toBe(false);
	});

	it("returns true when executor effort equals threshold (>=)", () => {
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		expect(isModelBlocked(sonnet, "high")).toBe(true);
	});

	it("returns true when executor effort above threshold", () => {
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		expect(isModelBlocked(sonnet, "xhigh")).toBe(true);
	});

	it("returns false when executor effort below threshold", () => {
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		expect(isModelBlocked(sonnet, "low")).toBe(false);
		expect(isModelBlocked(sonnet, "medium")).toBe(false);
	});

	it("returns false when executor effort is undefined with a minEffort threshold", () => {
		// indexOf(undefined) === -1, which is below any threshold ordinal.
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "minimal" }]);
		expect(isModelBlocked(sonnet, undefined)).toBe(false);
	});

	it("returns true when any entry in a mixed list matches", () => {
		setDisabledForModels(["openai:gpt-5", { model: "anthropic:sonnet", minEffort: "high" }]);
		expect(isModelBlocked(sonnet, "high")).toBe(true);
	});

	it("returns false when no entry in a mixed list matches", () => {
		setDisabledForModels(["openai:gpt-5", { model: "anthropic:sonnet", minEffort: "high" }]);
		expect(isModelBlocked(opus, "high")).toBe(false);
	});
});

import { resolveAdvisorChain, resolveChainLabels, setPerExecutor } from "./advisor/index.js";

const SONNET = { provider: "x", id: "sonnet", name: "Claude Sonnet" } as unknown as Model<Api>;
const KIMI = { provider: "k", id: "kimi", name: "Kimi K2" } as unknown as Model<Api>;
const GPT = { provider: "g", id: "gpt", name: "GPT-5" } as unknown as Model<Api>;
const OPUS = { provider: "o", id: "opus", name: "Claude Opus" } as unknown as Model<Api>;

const REGISTRY = {
	find: (provider: string, id: string) =>
		[SONNET, KIMI, GPT, OPUS].find((m) => m.provider === provider && m.id === id),
};

describe("resolveAdvisorChain", () => {
	beforeEach(() => setPerExecutor([]));

	it("returns an empty array when no chain exists", () => {
		expect(resolveAdvisorChain(SONNET, 3, undefined, REGISTRY)).toEqual([]);
	});

	it("returns an empty array when the executor is undefined", () => {
		setPerExecutor([{ executor: "x:sonnet", advisor: "k:kimi" }]);
		expect(resolveAdvisorChain(undefined, 3, undefined, REGISTRY)).toEqual([]);
	});

	it("walks up to the requested depth", () => {
		setPerExecutor([
			{ executor: "x:sonnet", advisor: "k:kimi" },
			{ executor: "k:kimi", advisor: "g:gpt" },
			{ executor: "g:gpt", advisor: "o:opus" },
		]);
		const nodes = resolveAdvisorChain(SONNET, 2, undefined, REGISTRY);
		expect(nodes.map((n) => `${n.model.provider}:${n.model.id}`)).toEqual(["k:kimi", "g:gpt"]);
	});

	it("stops at a target match (partial name)", () => {
		setPerExecutor([
			{ executor: "x:sonnet", advisor: "k:kimi" },
			{ executor: "k:kimi", advisor: "g:gpt" },
			{ executor: "g:gpt", advisor: "o:opus" },
		]);
		const nodes = resolveAdvisorChain(SONNET, 10, "opus", REGISTRY);
		expect(nodes.map((n) => n.model.id)).toEqual(["kimi", "gpt", "opus"]);
	});

	it("stops at a target match (full provider:id key)", () => {
		setPerExecutor([
			{ executor: "x:sonnet", advisor: "k:kimi" },
			{ executor: "k:kimi", advisor: "g:gpt" },
		]);
		const nodes = resolveAdvisorChain(SONNET, 10, "k:kimi", REGISTRY);
		expect(nodes.map((n) => n.model.id)).toEqual(["kimi"]);
	});

	it("detects a cycle and stops before revisiting a model", () => {
		setPerExecutor([
			{ executor: "x:sonnet", advisor: "k:kimi" },
			{ executor: "k:kimi", advisor: "g:gpt" },
			{ executor: "g:gpt", advisor: "k:kimi" },
		]);
		const nodes = resolveAdvisorChain(SONNET, 10, undefined, REGISTRY);
		expect(nodes.map((n) => n.model.id)).toEqual(["kimi", "gpt"]);
	});

	it("stops when the next advisor model is not in the registry", () => {
		setPerExecutor([
			{ executor: "x:sonnet", advisor: "k:kimi" },
			{ executor: "k:kimi", advisor: "missing:model" },
		]);
		const nodes = resolveAdvisorChain(SONNET, 10, undefined, REGISTRY);
		expect(nodes.map((n) => n.model.id)).toEqual(["kimi"]);
	});

	it("clamps depth into the [1, MAX] range", () => {
		setPerExecutor([{ executor: "x:sonnet", advisor: "k:kimi" }]);
		expect(resolveAdvisorChain(SONNET, 0, undefined, REGISTRY).map((n) => n.model.id)).toEqual(["kimi"]);
	});

	it("carries each entry's effort override onto its node", () => {
		setPerExecutor([
			{ executor: "x:sonnet", advisor: "k:kimi", effort: "high" },
			{ executor: "k:kimi", advisor: "g:gpt" },
		]);
		const nodes = resolveAdvisorChain(SONNET, 2, undefined, REGISTRY);
		expect(nodes[0].effort).toBe("high");
		expect(nodes[1].effort).toBeUndefined();
	});
});

describe("resolveChainLabels", () => {
	beforeEach(() => setPerExecutor([]));

	it("returns model display names in walk order", () => {
		setPerExecutor([
			{ executor: "x:sonnet", advisor: "k:kimi" },
			{ executor: "k:kimi", advisor: "g:gpt" },
		]);
		expect(resolveChainLabels(SONNET, REGISTRY)).toEqual(["Kimi K2", "GPT-5"]);
	});

	it("returns an empty array when there is no chain", () => {
		expect(resolveChainLabels(SONNET, REGISTRY)).toEqual([]);
	});
});
