import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ADVISOR_TOOL_NAME,
	buildAdvisorDescription,
	refreshAdvisorToolDescription,
	registerAdvisorTool,
	registerModelSelectHandler,
	setAdvisorModel,
	setDisabledForModels,
	setPerExecutor,
} from "./advisor/index.js";

const SONNET = { provider: "x", id: "sonnet", name: "Claude Sonnet" } as never;
const KIMI = { provider: "k", id: "kimi", name: "Kimi K2" } as never;
const GPT = { provider: "g", id: "gpt", name: "GPT-5" } as never;
const CHAIN_MODELS = [SONNET, KIMI, GPT];

function descriptionOf(captured: ReturnType<typeof createMockPi>["captured"]): string {
	return captured.tools.get(ADVISOR_TOOL_NAME)?.description ?? "";
}

beforeEach(() => {
	setPerExecutor([]);
	setDisabledForModels([]);
	setAdvisorModel(undefined);
});

describe("buildAdvisorDescription", () => {
	it("uses the static 'Takes NO parameters' wording when there is no chain", () => {
		const desc = buildAdvisorDescription();
		expect(desc).toContain("Takes NO parameters");
		expect(desc).not.toContain("Chain available");
	});

	it("appends a chain suffix naming the chain and the depth/target params", () => {
		const desc = buildAdvisorDescription(["Kimi K2", "GPT-5"]);
		expect(desc).not.toContain("Takes NO parameters");
		expect(desc).toContain("Chain available from current executor: Kimi K2 → GPT-5");
		expect(desc).toContain("depth");
		expect(desc).toContain("target");
	});

	it("treats an empty label array as no chain", () => {
		expect(buildAdvisorDescription([])).toBe(buildAdvisorDescription());
	});
});

describe("refreshAdvisorToolDescription", () => {
	it("re-registers when the description changes and skips when unchanged", () => {
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi); // baseline: no chain
		expect(descriptionOf(captured)).toContain("Takes NO parameters");
		const baselineCalls = vi.mocked(pi.registerTool).mock.calls.length;

		// Change → re-register.
		refreshAdvisorToolDescription(pi, ["Kimi K2", "GPT-5"]);
		expect(vi.mocked(pi.registerTool).mock.calls.length).toBe(baselineCalls + 1);
		expect(descriptionOf(captured)).toContain("Chain available");

		// Same labels → no re-register.
		refreshAdvisorToolDescription(pi, ["Kimi K2", "GPT-5"]);
		expect(vi.mocked(pi.registerTool).mock.calls.length).toBe(baselineCalls + 1);

		// Back to no chain → re-register.
		refreshAdvisorToolDescription(pi, []);
		expect(vi.mocked(pi.registerTool).mock.calls.length).toBe(baselineCalls + 2);
		expect(descriptionOf(captured)).toContain("Takes NO parameters");
	});

	it("does not activate the advisor tool when refreshing while it is inactive", () => {
		const { pi } = createMockPi();
		registerAdvisorTool(pi);
		pi.setActiveTools([]); // simulate a stripped/blocked tool
		refreshAdvisorToolDescription(pi, ["Kimi K2"]);
		expect(pi.getActiveTools()).not.toContain(ADVISOR_TOOL_NAME);
	});
});

describe("registerModelSelectHandler — dynamic description", () => {
	it("adds the chain suffix when the new executor has a chain", async () => {
		setAdvisorModel(KIMI);
		setPerExecutor([
			{ executor: "x:sonnet", advisor: "k:kimi" },
			{ executor: "k:kimi", advisor: "g:gpt" },
		]);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi); // baseline: no chain
		registerModelSelectHandler(pi);
		const handler = captured.events.get("model_select")?.[0];
		const ctx = createMockCtx({ hasUI: true, models: CHAIN_MODELS });
		await handler?.({ model: SONNET, previousModel: KIMI, source: "set" } as never, ctx as never);
		expect(descriptionOf(captured)).toContain("Chain available from current executor: Kimi K2 → GPT-5");
	});

	it("removes the chain suffix when the new executor has no chain", async () => {
		setAdvisorModel(KIMI);
		setPerExecutor([{ executor: "x:sonnet", advisor: "k:kimi" }]);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi, ["Kimi K2"]); // baseline: chain present
		expect(descriptionOf(captured)).toContain("Chain available");
		registerModelSelectHandler(pi);
		const handler = captured.events.get("model_select")?.[0];
		// gpt has no perExecutor entry → no chain from it.
		const ctx = createMockCtx({ hasUI: true, models: CHAIN_MODELS });
		await handler?.({ model: GPT, previousModel: KIMI, source: "set" } as never, ctx as never);
		expect(descriptionOf(captured)).toContain("Takes NO parameters");
		expect(descriptionOf(captured)).not.toContain("Chain available");
	});

	it("keeps the tool stripped for a blocked executor even when refreshing the description", async () => {
		setAdvisorModel(KIMI);
		setDisabledForModels(["x:sonnet"]); // sonnet is a blocked executor
		setPerExecutor([
			{ executor: "x:sonnet", advisor: "k:kimi" },
			{ executor: "k:kimi", advisor: "g:gpt" },
		]);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		registerAdvisorTool(pi);
		registerModelSelectHandler(pi);
		const handler = captured.events.get("model_select")?.[0];
		const ctx = createMockCtx({ hasUI: true, models: CHAIN_MODELS });
		await handler?.({ model: SONNET, previousModel: KIMI, source: "set" } as never, ctx as never);
		// reconcile stripped the tool (blocked); the description refresh must not resurrect it.
		expect(pi.getActiveTools()).not.toContain(ADVISOR_TOOL_NAME);
	});

	it("does not refresh the description when no advisor model is configured", async () => {
		setAdvisorModel(undefined);
		setPerExecutor([{ executor: "x:sonnet", advisor: "k:kimi" }]);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		registerModelSelectHandler(pi);
		const handler = captured.events.get("model_select")?.[0];
		const callsBefore = vi.mocked(pi.registerTool).mock.calls.length;
		const ctx = createMockCtx({ hasUI: true, models: CHAIN_MODELS });
		await handler?.({ model: SONNET, previousModel: KIMI, source: "set" } as never, ctx as never);
		expect(vi.mocked(pi.registerTool).mock.calls.length).toBe(callsBefore);
	});
});
