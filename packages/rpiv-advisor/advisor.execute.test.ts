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

	it("proceeds when apiKey is missing but the provider is authenticated (e.g. Bedrock AWS profile)", async () => {
		setAdvisorModel({ provider: "amazon-bedrock", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		// Credential-chain auth: no apiKey and no auth headers, but the provider is
		// configured/authenticated (AWS SDK resolves creds from the profile chain).
		(ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: true,
			apiKey: undefined,
			headers: undefined,
		});
		(ctx.modelRegistry.getProviderAuthStatus as ReturnType<typeof vi.fn>).mockReturnValueOnce({
			configured: true,
			source: "environment",
			label: "AWS_PROFILE",
		});
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
		expect(r?.content[0]).toMatchObject({ type: "text", text: "advice" });
		expect(r?.details).toMatchObject({ advisorModel: "amazon-bedrock:m" });
	});
});
