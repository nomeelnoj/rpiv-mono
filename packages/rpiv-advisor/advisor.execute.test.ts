import {
	buildSessionEntries,
	createMockCtx,
	createMockPi,
	makeAssistantMessage,
	makeUserMessage,
} from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		completeSimple: vi.fn(),
		getSupportedThinkingLevels: vi.fn(() => ["off", "minimal", "low", "medium", "high"]),
	};
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		buildSessionContext: vi.fn(),
	};
});

import { completeSimple } from "@earendil-works/pi-ai";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { registerAdvisorTool, setAdvisorEffort, setAdvisorModel, setPerExecutor } from "./advisor/index.js";

function resp(input: { text?: string; stopReason?: "done" | "aborted" | "error" | "toolUse"; errorMessage?: string }) {
	return {
		role: "assistant",
		content: input.text ? [{ type: "text", text: input.text }] : [],
		timestamp: Date.now(),
		stopReason: input.stopReason ?? "done",
		errorMessage: input.errorMessage,
	};
}

beforeEach(() => {
	vi.mocked(completeSimple).mockReset();
	vi.mocked(buildSessionContext).mockImplementation(
		(entries) =>
			({
				messages: ((entries ?? []) as { type?: string; message?: unknown }[])
					.filter((e) => e?.type === "message")
					.map((e) => (e as { message: unknown }).message),
				thinkingLevel: "off",
				model: null,
			}) as ReturnType<typeof buildSessionContext>,
	);
});

describe("executeAdvisor — 4 StopReason branches", () => {
	it("happy path returns advisor text", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({
			branch: buildSessionEntries([makeUserMessage("q"), makeAssistantMessage({ text: "a" })]),
		});
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ type: "text", text: "advice" });
		expect(r?.details).toMatchObject({ advisorModel: "a:m" });
	});

	it("uses compacted session context instead of raw branch messages", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "advice" }) as never);
		vi.mocked(buildSessionContext).mockReturnValueOnce({
			messages: [
				{
					role: "compactionSummary",
					summary: "COMPACTED SUMMARY OF EARLIER WORK",
					tokensBefore: 12345,
					timestamp: Date.now(),
				},
				makeUserMessage("kept user message"),
				makeAssistantMessage({ text: "post-compaction assistant" }),
			],
			thinkingLevel: "off",
			model: null,
		} as ReturnType<typeof buildSessionContext>);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({
			branch: buildSessionEntries([
				makeUserMessage("OLD RAW PRE-COMPACTION DETAIL"),
				makeAssistantMessage({ text: "old raw assistant detail" }),
			]),
		});

		await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);

		const payload = vi.mocked(completeSimple).mock.calls[0]?.[1] as { messages?: unknown[] };
		const serialized = JSON.stringify(payload.messages);
		expect(serialized).toContain("COMPACTED SUMMARY OF EARLIER WORK");
		expect(serialized).toContain("kept user message");
		expect(serialized).toContain("post-compaction assistant");
		expect(serialized).not.toContain("OLD RAW PRE-COMPACTION DETAIL");
		expect(serialized).not.toContain("old raw assistant detail");
	});

	it("aborted stopReason returns cancel envelope", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ stopReason: "aborted" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.details).toMatchObject({ stopReason: "aborted", errorMessage: "aborted" });
	});

	it("error stopReason returns wrapped errorMessage", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ stopReason: "error", errorMessage: "502" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("502") });
		expect(r?.details).toMatchObject({ stopReason: "error", errorMessage: "502" });
	});

	it("empty-response returns ERR_EMPTY_RESPONSE envelope", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "   " }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.details).toMatchObject({ errorMessage: "empty response" });
	});

	it("perExecutor override routes to a different advisor model when executor matches", async () => {
		const defaultAdvisor = { provider: "a", id: "default-advisor" } as never;
		const overrideAdvisor = { provider: "b", id: "override-advisor" } as never;
		const executor = { provider: "x", id: "executor" } as never;
		setAdvisorModel(defaultAdvisor);
		setAdvisorEffort("low");
		setPerExecutor([{ executor: "x:executor", advisor: "b:override-advisor", effort: "high" }]);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "override advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: executor, models: [defaultAdvisor, overrideAdvisor, executor] });
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple).mock.calls[0]?.[0]).toMatchObject({ provider: "b", id: "override-advisor" });
		expect(vi.mocked(completeSimple).mock.calls[0]?.[2]).toMatchObject({ reasoning: "high" });
		expect(r?.details).toMatchObject({ advisorModel: "b:override-advisor", effort: "high" });
	});

	it("perExecutor override inherits top-level effort when entry omits effort", async () => {
		const defaultAdvisor = { provider: "a", id: "default-advisor" } as never;
		const overrideAdvisor = { provider: "b", id: "override-advisor" } as never;
		const executor = { provider: "x", id: "executor" } as never;
		setAdvisorModel(defaultAdvisor);
		setAdvisorEffort("medium");
		setPerExecutor([{ executor: "x:executor", advisor: "b:override-advisor" }]);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: executor, models: [defaultAdvisor, overrideAdvisor, executor] });
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple).mock.calls[0]?.[2]).toMatchObject({ reasoning: "medium" });
		expect(r?.details).toMatchObject({ advisorModel: "b:override-advisor", effort: "medium" });
	});

	it("falls back to default advisor when executor doesn't match any perExecutor entry", async () => {
		const defaultAdvisor = { provider: "a", id: "default-advisor" } as never;
		const executor = { provider: "x", id: "unmatched" } as never;
		setAdvisorModel(defaultAdvisor);
		setAdvisorEffort("low");
		setPerExecutor([{ executor: "x:executor", advisor: "b:override-advisor", effort: "high" }]);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: executor, models: [defaultAdvisor, executor] });
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple).mock.calls[0]?.[0]).toMatchObject({ provider: "a", id: "default-advisor" });
		expect(r?.details).toMatchObject({ advisorModel: "a:default-advisor", effort: "low" });
	});

	it("falls back to default advisor when override model is not in registry", async () => {
		const defaultAdvisor = { provider: "a", id: "default-advisor" } as never;
		const executor = { provider: "x", id: "executor" } as never;
		setAdvisorModel(defaultAdvisor);
		setAdvisorEffort("low");
		setPerExecutor([{ executor: "x:executor", advisor: "missing:from-registry", effort: "high" }]);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: executor, models: [defaultAdvisor, executor] });
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple).mock.calls[0]?.[0]).toMatchObject({ provider: "a", id: "default-advisor" });
		expect(r?.details).toMatchObject({ advisorModel: "a:default-advisor", effort: "low" });
	});

	it("falls back to default advisor when ctx.model is undefined", async () => {
		const defaultAdvisor = { provider: "a", id: "default-advisor" } as never;
		setAdvisorModel(defaultAdvisor);
		setPerExecutor([{ executor: "x:executor", advisor: "b:override-advisor" }]);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ models: [defaultAdvisor] });
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.details).toMatchObject({ advisorModel: "a:default-advisor" });
	});

	it("picks the first matching perExecutor entry and ignores later duplicates", async () => {
		const defaultAdvisor = { provider: "a", id: "default-advisor" } as never;
		const firstOverride = { provider: "b", id: "first" } as never;
		const secondOverride = { provider: "c", id: "second" } as never;
		const executor = { provider: "x", id: "executor" } as never;
		setAdvisorModel(defaultAdvisor);
		setPerExecutor([
			{ executor: "x:executor", advisor: "b:first" },
			{ executor: "x:executor", advisor: "c:second" },
		]);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: executor, models: [defaultAdvisor, firstOverride, secondOverride, executor] });
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.details).toMatchObject({ advisorModel: "b:first" });
	});

	it("thrown error is caught and wrapped in details.errorMessage", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockRejectedValueOnce(new Error("boom"));
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("boom") });
		expect(r?.details).toMatchObject({ errorMessage: "boom" });
	});
});

describe("executeAdvisor — auth envelopes", () => {
	it("returns no-model envelope when advisor is not configured", async () => {
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.details).toMatchObject({ errorMessage: "no advisor model selected" });
	});

	it("wraps misconfigured auth into details.errorMessage", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		(ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: false,
			error: "bad config",
		});
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("bad config") });
		expect(r?.details).toMatchObject({ errorMessage: "bad config", advisorModel: "a:m" });
	});

	it("returns no-api-key envelope when auth.ok but apiKey is missing", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		(ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: true,
			apiKey: undefined,
			headers: {},
		});
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("no API key") });
		expect(r?.details).toMatchObject({ errorMessage: "no API key for a", advisorModel: "a:m" });
	});
});

// ── Chain walking ──────────────────────────────────────────────────────────────
// Chain topology comes from the perExecutor table: each model's `advisor` entry
// is the next hop. sonnet → kimi → gpt → opus.
const SONNET = { provider: "x", id: "sonnet", name: "Claude Sonnet" } as never;
const KIMI = { provider: "k", id: "kimi", name: "Kimi K2" } as never;
const GPT = { provider: "g", id: "gpt", name: "GPT-5" } as never;
const OPUS = { provider: "o", id: "opus", name: "Claude Opus" } as never;
const CHAIN_MODELS = [SONNET, KIMI, GPT, OPUS];

function fullChain() {
	setPerExecutor([
		{ executor: "x:sonnet", advisor: "k:kimi" },
		{ executor: "k:kimi", advisor: "g:gpt" },
		{ executor: "g:gpt", advisor: "o:opus" },
	]);
}

function callMessagesText(callIndex: number): string {
	const payload = vi.mocked(completeSimple).mock.calls[callIndex]?.[1] as { messages?: unknown[] };
	return JSON.stringify(payload.messages ?? []);
}

describe("executeAdvisor — chain walking", () => {
	it("depth:1 takes the single-hop path (no chain walk)", async () => {
		setAdvisorModel(SONNET);
		fullChain();
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "kimi advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: SONNET, models: CHAIN_MODELS });
		const r = await captured.tools
			.get("advisor")
			?.execute?.("tc", { depth: 1 }, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(completeSimple).mock.calls[0]?.[0]).toMatchObject({ provider: "k", id: "kimi" });
		expect(r?.details).toMatchObject({ advisorModel: "k:kimi" });
	});

	it("depth:2 calls completeSimple twice and tier 2 sees tier 1's response", async () => {
		setAdvisorModel(SONNET);
		fullChain();
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({ text: "TIER ONE ADVICE" }) as never)
			.mockResolvedValueOnce(resp({ text: "tier two advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: SONNET, models: CHAIN_MODELS });
		const r = await captured.tools
			.get("advisor")
			?.execute?.("tc", { depth: 2 }, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(completeSimple).mock.calls[0]?.[0]).toMatchObject({ provider: "k", id: "kimi" });
		expect(vi.mocked(completeSimple).mock.calls[1]?.[0]).toMatchObject({ provider: "g", id: "gpt" });
		// Tier 1 messages must NOT contain a prior-response block; tier 2 must.
		expect(callMessagesText(0)).not.toContain("TIER ONE ADVICE");
		expect(callMessagesText(1)).toContain("TIER ONE ADVICE");
		// Final tier's response is returned.
		expect(r?.content[0]).toMatchObject({ text: "tier two advice" });
		expect(r?.details).toMatchObject({ advisorModel: "g:gpt" });
	});

	it("depth:3 walks the full chain, accumulating prior responses each tier", async () => {
		setAdvisorModel(SONNET);
		fullChain();
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({ text: "AAA-kimi" }) as never)
			.mockResolvedValueOnce(resp({ text: "BBB-gpt" }) as never)
			.mockResolvedValueOnce(resp({ text: "CCC-opus" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: SONNET, models: CHAIN_MODELS });
		const r = await captured.tools
			.get("advisor")
			?.execute?.("tc", { depth: 3 }, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(3);
		// Tier 3 sees both prior responses.
		expect(callMessagesText(2)).toContain("AAA-kimi");
		expect(callMessagesText(2)).toContain("BBB-gpt");
		expect(r?.content[0]).toMatchObject({ text: "CCC-opus" });
		expect(r?.details).toMatchObject({ advisorModel: "o:opus" });
	});

	it("target stops the walk early even when depth would go further", async () => {
		setAdvisorModel(SONNET);
		fullChain();
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({ text: "kimi" }) as never)
			.mockResolvedValueOnce(resp({ text: "gpt advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: SONNET, models: CHAIN_MODELS });
		const r = await captured.tools
			.get("advisor")
			?.execute?.("tc", { depth: 5, target: "gpt" }, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(2);
		expect(r?.details).toMatchObject({ advisorModel: "g:gpt" });
	});

	it("target matches a full provider:id key", async () => {
		setAdvisorModel(SONNET);
		fullChain();
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({ text: "kimi" }) as never)
			.mockResolvedValueOnce(resp({ text: "gpt" }) as never)
			.mockResolvedValueOnce(resp({ text: "opus advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: SONNET, models: CHAIN_MODELS });
		const r = await captured.tools
			.get("advisor")
			?.execute?.("tc", { target: "o:opus" }, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(3);
		expect(r?.details).toMatchObject({ advisorModel: "o:opus" });
	});

	it("target not present in the chain terminates at the deepest reached tier", async () => {
		setAdvisorModel(SONNET);
		// Chain ends at gpt (no entry for gpt).
		setPerExecutor([
			{ executor: "x:sonnet", advisor: "k:kimi" },
			{ executor: "k:kimi", advisor: "g:gpt" },
		]);
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({ text: "kimi" }) as never)
			.mockResolvedValueOnce(resp({ text: "gpt deepest" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: SONNET, models: CHAIN_MODELS });
		const r = await captured.tools
			.get("advisor")
			?.execute?.("tc", { target: "opus" }, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(2);
		expect(r?.details).toMatchObject({ advisorModel: "g:gpt" });
	});

	it("cycle in the chain terminates before revisit and warns", async () => {
		setAdvisorModel(SONNET);
		// sonnet → kimi → gpt → kimi (cycle back to kimi).
		setPerExecutor([
			{ executor: "x:sonnet", advisor: "k:kimi" },
			{ executor: "k:kimi", advisor: "g:gpt" },
			{ executor: "g:gpt", advisor: "k:kimi" },
		]);
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({ text: "kimi" }) as never)
			.mockResolvedValueOnce(resp({ text: "gpt last" }) as never);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: SONNET, models: CHAIN_MODELS });
		const r = await captured.tools
			.get("advisor")
			?.execute?.("tc", { depth: 8 }, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(2);
		expect(r?.details).toMatchObject({ advisorModel: "g:gpt" });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("cycle"));
		warn.mockRestore();
	});

	it("terminates when a tier has no perExecutor entry", async () => {
		setAdvisorModel(SONNET);
		setPerExecutor([{ executor: "x:sonnet", advisor: "k:kimi" }]); // kimi has no entry
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "kimi only" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: SONNET, models: CHAIN_MODELS });
		const r = await captured.tools
			.get("advisor")
			?.execute?.("tc", { depth: 4 }, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
		expect(r?.details).toMatchObject({ advisorModel: "k:kimi" });
	});

	it("terminates when a tier's advisor model is not in the registry", async () => {
		setAdvisorModel(SONNET);
		setPerExecutor([
			{ executor: "x:sonnet", advisor: "k:kimi" },
			{ executor: "k:kimi", advisor: "missing:model" },
		]);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "kimi only" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: SONNET, models: CHAIN_MODELS });
		const r = await captured.tools
			.get("advisor")
			?.execute?.("tc", { depth: 4 }, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
		expect(r?.details).toMatchObject({ advisorModel: "k:kimi" });
	});

	it("depth and target both set — stops at whichever comes first (depth)", async () => {
		setAdvisorModel(SONNET);
		fullChain();
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({ text: "kimi" }) as never)
			.mockResolvedValueOnce(resp({ text: "gpt" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: SONNET, models: CHAIN_MODELS });
		// opus is tier 3, but depth 2 exhausts first.
		const r = await captured.tools
			.get("advisor")
			?.execute?.("tc", { depth: 2, target: "opus" }, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(2);
		expect(r?.details).toMatchObject({ advisorModel: "g:gpt" });
	});

	it("falls back to single-hop when no chain exists from the executor", async () => {
		setAdvisorModel(KIMI); // default advisor
		setPerExecutor([]); // no routes
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "default advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: SONNET, models: CHAIN_MODELS });
		const r = await captured.tools
			.get("advisor")
			?.execute?.("tc", { depth: 3 }, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
		expect(r?.details).toMatchObject({ advisorModel: "k:kimi" });
	});

	it("each tier inherits the call-site effort unless the entry overrides it", async () => {
		setAdvisorModel(SONNET);
		setAdvisorEffort("medium");
		setPerExecutor([
			{ executor: "x:sonnet", advisor: "k:kimi" }, // inherit → medium
			{ executor: "k:kimi", advisor: "g:gpt", effort: "high" }, // explicit → high
		]);
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({ text: "kimi" }) as never)
			.mockResolvedValueOnce(resp({ text: "gpt" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: SONNET, models: CHAIN_MODELS });
		const r = await captured.tools
			.get("advisor")
			?.execute?.("tc", { depth: 2 }, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple).mock.calls[0]?.[2]).toMatchObject({ reasoning: "medium" });
		expect(vi.mocked(completeSimple).mock.calls[1]?.[2]).toMatchObject({ reasoning: "high" });
		expect(r?.details).toMatchObject({ advisorModel: "g:gpt", effort: "high" });
	});

	it("a later-tier error surfaces that tier's error envelope (failures are not hidden)", async () => {
		setAdvisorModel(SONNET);
		fullChain();
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({ text: "kimi good" }) as never)
			.mockResolvedValueOnce(resp({ stopReason: "error", errorMessage: "502" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: SONNET, models: CHAIN_MODELS });
		const r = await captured.tools
			.get("advisor")
			?.execute?.("tc", { depth: 3 }, undefined as never, undefined as never, ctx);
		// Tier 2 errored → surface tier 2's error envelope, not tier 1's advice.
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("502") });
		expect(r?.details).toMatchObject({ advisorModel: "g:gpt", stopReason: "error", errorMessage: "502" });
	});

	it("a later-tier abort returns the last completed tier's response (cancellation keeps partial output)", async () => {
		setAdvisorModel(SONNET);
		fullChain();
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({ text: "kimi good" }) as never)
			.mockResolvedValueOnce(resp({ stopReason: "aborted" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: SONNET, models: CHAIN_MODELS });
		const r = await captured.tools
			.get("advisor")
			?.execute?.("tc", { depth: 3 }, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ text: "kimi good" });
		expect(r?.details).toMatchObject({ advisorModel: "k:kimi" });
	});

	it("deeper tiers inherit tier 1's explicit effort when they omit their own", async () => {
		setAdvisorModel(SONNET);
		setAdvisorEffort("low");
		setPerExecutor([
			{ executor: "x:sonnet", advisor: "k:kimi", effort: "high" }, // explicit tier-1 effort
			{ executor: "k:kimi", advisor: "g:gpt" }, // omits → inherits tier-1's "high", not the call-site "low"
		]);
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({ text: "kimi" }) as never)
			.mockResolvedValueOnce(resp({ text: "gpt" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ model: SONNET, models: CHAIN_MODELS });
		const r = await captured.tools
			.get("advisor")
			?.execute?.("tc", { depth: 2 }, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple).mock.calls[0]?.[2]).toMatchObject({ reasoning: "high" });
		expect(vi.mocked(completeSimple).mock.calls[1]?.[2]).toMatchObject({ reasoning: "high" });
		expect(r?.details).toMatchObject({ advisorModel: "g:gpt", effort: "high" });
	});
});
