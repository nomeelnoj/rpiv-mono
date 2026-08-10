import type { Api, Model } from "@earendil-works/pi-ai";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./advisor-ui.js", () => ({
	showAdvisorPicker: vi.fn(),
	showEffortPicker: vi.fn(),
	showScopePicker: vi.fn(),
	showRouteListPicker: vi.fn(),
	showRouteExecutorPicker: vi.fn(),
	showRouteAdvisorPicker: vi.fn(),
	showRouteEffortPicker: vi.fn(),
	showRouteActionPicker: vi.fn(),
}));

import {
	ADVISOR_TOOL_NAME,
	findPerExecutorOverride,
	getAdvisorEffort,
	getAdvisorModel,
	registerAdvisorBeforeAgentStart,
	registerAdvisorCommand,
	registerModelSelectHandler,
	registerThinkingLevelSelectHandler,
	restoreAdvisorState,
	savePerExecutor,
	setAdvisorModel,
	setDisabledForModels,
} from "./advisor/index.js";
import {
	ADD_ROUTE_VALUE,
	CONFIRM_RESET_VALUE,
	INHERIT_VALUE,
	NO_ADVISOR_VALUE,
	REMOVE_VALUE,
	RESET_ALL_ROUTES_VALUE,
	SCOPE_DEFAULT,
	SCOPE_ROUTES,
} from "./advisor/messages.js";
import {
	showAdvisorPicker,
	showEffortPicker,
	showRouteActionPicker,
	showRouteAdvisorPicker,
	showRouteEffortPicker,
	showRouteExecutorPicker,
	showRouteListPicker,
	showScopePicker,
} from "./advisor-ui.js";

const modelA = { provider: "anthropic", id: "opus", name: "Opus" } as unknown as Model<Api>;
const modelR = {
	provider: "anthropic",
	id: "opus-thinking",
	name: "Opus Thinking",
	reasoning: true,
} as unknown as Model<Api>;
const modelBlocked = { provider: "anthropic", id: "sonnet", name: "Sonnet" } as unknown as Model<Api>;

beforeEach(() => {
	vi.mocked(showAdvisorPicker).mockReset();
	vi.mocked(showEffortPicker).mockReset();
	vi.mocked(showScopePicker).mockReset();
	vi.mocked(showRouteListPicker).mockReset();
	vi.mocked(showRouteExecutorPicker).mockReset();
	vi.mocked(showRouteAdvisorPicker).mockReset();
	vi.mocked(showRouteEffortPicker).mockReset();
	vi.mocked(showRouteActionPicker).mockReset();
	// Default: scope picker routes to the default-advisor branch so the many
	// existing tests that mock showAdvisorPicker continue to work without change.
	// Tests that exercise scope routing can override with mockResolvedValueOnce.
	vi.mocked(showScopePicker).mockResolvedValue(SCOPE_DEFAULT);
});

function register() {
	const { pi, captured } = createMockPi();
	registerAdvisorCommand(pi);
	return { pi, captured, handler: () => captured.commands.get("advisor")?.handler };
}

describe("/advisor — command shape", () => {
	it("registers under 'advisor'", () => {
		const { captured } = register();
		expect(captured.commands.has("advisor")).toBe(true);
	});
});

describe("/advisor — !hasUI", () => {
	it("notifies error and skips picker", async () => {
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: false });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(showAdvisorPicker).not.toHaveBeenCalled();
	});
});

describe("/advisor — user cancels picker", () => {
	it("no-ops when showAdvisorPicker resolves null", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce(null);
		const { pi, captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(getAdvisorModel()).toBeUndefined();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("/advisor — NO_ADVISOR", () => {
	it("clears model+effort, drops advisor from active tools, notifies disabled", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("__no_advisor__");
		const { pi, captured } = register();
		pi.setActiveTools([ADVISOR_TOOL_NAME, "other"]);
		setAdvisorModel(modelA);
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(getAdvisorModel()).toBeUndefined();
		expect(getAdvisorEffort()).toBeUndefined();
		expect(pi.setActiveTools).toHaveBeenLastCalledWith(["other"]);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Advisor disabled"), "info");
	});

	it("skips setActiveTools when advisor was not in the list", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("__no_advisor__");
		const { pi, captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Advisor disabled"), "info");
	});
});

describe("/advisor — selection not found", () => {
	it("notifies errSelectionNotFound when pick is unknown", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("ghost:nonesuch");
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Advisor selection not found"), "error");
	});
});

describe("/advisor — non-reasoning model", () => {
	it("sets model, adds tool, notifies enabled (no effort suffix)", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic:opus");
		const { pi, captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(getAdvisorModel()).toBe(modelA);
		expect(getAdvisorEffort()).toBeUndefined();
		expect(pi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining([ADVISOR_TOOL_NAME]));
		const [msg] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [];
		expect(msg).toBe("Advisor: anthropic:opus");
		expect(showEffortPicker).not.toHaveBeenCalled();
	});
});

describe("/advisor — reasoning model", () => {
	it("returns early when effort picker is cancelled", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic:opus-thinking");
		vi.mocked(showEffortPicker).mockResolvedValueOnce(null);
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelR] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(getAdvisorModel()).toBeUndefined();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("OFF_VALUE yields effort=undefined", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic:opus-thinking");
		vi.mocked(showEffortPicker).mockResolvedValueOnce("__off__");
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelR] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(getAdvisorModel()).toBe(modelR);
		expect(getAdvisorEffort()).toBeUndefined();
		const [msg] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [];
		expect(msg).toBe("Advisor: anthropic:opus-thinking");
	});

	it("explicit level persists effort + shows it in enabled notification", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic:opus-thinking");
		vi.mocked(showEffortPicker).mockResolvedValueOnce("medium");
		const { pi, captured } = register();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		const ctx = createMockCtx({ hasUI: true, models: [modelR] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(getAdvisorModel()).toBe(modelR);
		expect(getAdvisorEffort()).toBe("medium");
		const [msg] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [];
		expect(msg).toBe("Advisor: anthropic:opus-thinking, medium");
	});
});

describe("/advisor — save failure (persist-first ordering, review I2)", () => {
	it("disable path: error notify; in-memory model + active tools unchanged", async () => {
		if (process.platform === "win32") return;
		const { mkdirSync, rmSync } = await import("node:fs");
		const { dirname, join } = await import("node:path");
		const configPath = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mkdirSync(dirname(configPath), { recursive: true });
		// Force EISDIR on writeFileSync — same trick the web-tools save-failure
		// test uses. Drives saveAdvisorConfig → false through the real disk path.
		mkdirSync(configPath, { recursive: true });
		try {
			vi.mocked(showAdvisorPicker).mockResolvedValueOnce("__no_advisor__");
			const { pi, captured } = register();
			pi.setActiveTools([ADVISOR_TOOL_NAME, "other"]);
			vi.mocked(pi.setActiveTools).mockClear();
			setAdvisorModel(modelA);
			const ctx = createMockCtx({ hasUI: true, models: [modelA] });

			await captured.commands.get("advisor")?.handler("", ctx as never);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Failed to save advisor selection"),
				"error",
			);
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Advisor disabled"), "info");
			// Persist-first: in-memory model and active-tools registry must be untouched.
			expect(getAdvisorModel()).toBe(modelA);
			expect(pi.setActiveTools).not.toHaveBeenCalled();
		} finally {
			rmSync(configPath, { recursive: true, force: true });
		}
	});

	it("enable path: error notify; in-memory model + active tools unchanged", async () => {
		if (process.platform === "win32") return;
		const { mkdirSync, rmSync } = await import("node:fs");
		const { dirname, join } = await import("node:path");
		const configPath = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mkdirSync(dirname(configPath), { recursive: true });
		mkdirSync(configPath, { recursive: true });
		try {
			vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic:opus");
			const { pi, captured } = register();
			const ctx = createMockCtx({ hasUI: true, models: [modelA] });

			await captured.commands.get("advisor")?.handler("", ctx as never);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Failed to save advisor selection"),
				"error",
			);
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Advisor: anthropic:opus"), "info");
			// Persist-first: in-memory model must NOT be set; tool must NOT be added.
			expect(getAdvisorModel()).toBeUndefined();
			expect(pi.setActiveTools).not.toHaveBeenCalledWith(expect.arrayContaining([ADVISOR_TOOL_NAME]));
		} finally {
			rmSync(configPath, { recursive: true, force: true });
		}
	});
});

describe("registerAdvisorBeforeAgentStart", () => {
	it("strips advisor from active tools when no model is set", async () => {
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME, "other"]);
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		await handler?.({} as never, undefined as never);
		expect(pi.setActiveTools).toHaveBeenLastCalledWith(["other"]);
	});

	it("no-ops when advisor is not in active tools", async () => {
		const { pi, captured } = createMockPi();
		pi.setActiveTools(["other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		await handler?.({} as never, undefined as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("no-ops when an advisor model is set", async () => {
		setAdvisorModel(modelA);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		await handler?.({} as never, undefined as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("restoreAdvisorState — blocklist", () => {
	it("skips tool activation when executor is blocked but still sets model", async () => {
		const { writeFileSync, mkdirSync } = await import("node:fs");
		const { dirname, join } = await import("node:path");
		const configPath = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({
				modelKey: "anthropic:opus",
				disabledForModels: ["anthropic:sonnet"],
			}),
		);

		const { pi } = createMockPi();
		const ctx = createMockCtx({
			hasUI: true,
			model: modelBlocked,
			models: [modelA],
		});
		restoreAdvisorState(ctx as never, pi);
		expect(getAdvisorModel()).toBe(modelA);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("activates tool when executor is not blocked", async () => {
		const { writeFileSync, mkdirSync } = await import("node:fs");
		const { dirname, join } = await import("node:path");
		const configPath = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({
				modelKey: "anthropic:opus",
				disabledForModels: ["anthropic:sonnet"],
			}),
		);

		const { pi } = createMockPi();
		const ctx = createMockCtx({
			hasUI: true,
			model: modelA,
			models: [modelA],
		});
		restoreAdvisorState(ctx as never, pi);
		expect(getAdvisorModel()).toBe(modelA);
		expect(pi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining([ADVISOR_TOOL_NAME]));
	});
});

describe("registerAdvisorBeforeAgentStart — blocklist", () => {
	it("strips advisor when executor model is blocked", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels(["anthropic:sonnet"]);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelBlocked });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenLastCalledWith([]);
	});

	it("no-ops when executor model is not blocked", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels(["anthropic:sonnet"]);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelA });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("no-ops when blocklist is empty", async () => {
		setAdvisorModel(modelA);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelBlocked });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("registerModelSelectHandler — blocklist", () => {
	it("strips advisor when switching to blocked model", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels(["anthropic:sonnet"]);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		registerModelSelectHandler(pi);
		const handler = captured.events.get("model_select")?.[0];
		const ctx = createMockCtx({ hasUI: true });
		await handler?.({ model: modelBlocked, previousModel: modelA, source: "set" } as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenLastCalledWith([]);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("disabled for"), "info");
	});

	it("re-adds advisor when switching from blocked to non-blocked", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels(["anthropic:sonnet"]);
		const { pi, captured } = createMockPi();
		registerModelSelectHandler(pi);
		const handler = captured.events.get("model_select")?.[0];
		const ctx = createMockCtx({ hasUI: true });
		await handler?.({ model: modelA, previousModel: modelBlocked, source: "set" } as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining([ADVISOR_TOOL_NAME]));
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("restored"), "info");
	});

	it("no-ops when no advisor model is configured", async () => {
		setDisabledForModels(["anthropic:sonnet"]);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerModelSelectHandler(pi);
		const handler = captured.events.get("model_select")?.[0];
		const ctx = createMockCtx({ hasUI: true });
		await handler?.({ model: modelBlocked, previousModel: modelA, source: "set" } as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("no-ops when source is 'restore' (avoids duplicate notification with restoreAdvisorState)", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels(["anthropic:sonnet"]);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerModelSelectHandler(pi);
		const handler = captured.events.get("model_select")?.[0];
		const ctx = createMockCtx({ hasUI: true });
		await handler?.({ model: modelBlocked, previousModel: undefined, source: "restore" } as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});

describe("/advisor — blocked executor notification", () => {
	it("shows inactive notification and does NOT activate the tool when executor is blocked", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic:opus");
		setDisabledForModels(["anthropic:sonnet"]);
		const { pi, captured } = register();
		vi.mocked(pi.setActiveTools).mockClear();
		const ctx = createMockCtx({ hasUI: true, models: [modelA], model: modelBlocked });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("inactive for current executor"), "info");
		const calls = vi.mocked(pi.setActiveTools).mock.calls;
		for (const [tools] of calls) {
			expect(tools).not.toContain(ADVISOR_TOOL_NAME);
		}
	});

	it("strips advisor from active tools when /advisor runs with executor blocked and tool already active", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic:opus");
		setDisabledForModels(["anthropic:sonnet"]);
		const { pi, captured } = register();
		pi.setActiveTools([ADVISOR_TOOL_NAME, "other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		const ctx = createMockCtx({ hasUI: true, models: [modelA], model: modelBlocked });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["other"]);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("inactive for current executor"), "info");
	});

	it("shows enabled notification without inactive qualifier when executor is not blocked", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic:opus");
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA], model: modelA });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		const [msg, severity] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [];
		expect(msg).toBe("Advisor: anthropic:opus");
		expect(severity).toBe("info");
	});

	it("shows inactive notification when executor blocked by effort-aware entry at threshold", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic:opus");
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = register();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("high");
		vi.mocked(pi.setActiveTools).mockClear();
		const ctx = createMockCtx({ hasUI: true, models: [modelA], model: modelBlocked });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("inactive for current executor"), "info");
		const calls = vi.mocked(pi.setActiveTools).mock.calls;
		for (const [tools] of calls) {
			expect(tools).not.toContain(ADVISOR_TOOL_NAME);
		}
	});

	it("shows enabled notification when executor effort below threshold for effort-aware entry", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic:opus");
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA], model: modelBlocked });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		const [msg, severity] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [];
		expect(msg).toBe("Advisor: anthropic:opus");
		expect(severity).toBe("info");
	});
});

describe("registerAdvisorBeforeAgentStart — effort-aware blocklist", () => {
	it("strips advisor when effort at threshold", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("high");
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelBlocked });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenLastCalledWith([]);
	});

	it("re-adds advisor when effort drops below threshold", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("low");
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelBlocked });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining([ADVISOR_TOOL_NAME]));
	});

	it("no-ops when effort at threshold but model is not blocked", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("high");
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelA });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("does not block when thinking level is off", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("off");
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelBlocked });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("blocks when effort is one above threshold", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "medium" }]);
		const { pi, captured } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("high");
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelBlocked });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenLastCalledWith([]);
	});

	it("does not block when effort is one below threshold", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("medium");
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelBlocked });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("registerModelSelectHandler — effort-aware blocklist", () => {
	it("strips advisor when model matches and effort at threshold", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("high");
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		registerModelSelectHandler(pi);
		const handler = captured.events.get("model_select")?.[0];
		const ctx = createMockCtx({ hasUI: true });
		await handler?.({ model: modelBlocked, previousModel: modelA, source: "set" } as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenLastCalledWith([]);
	});

	it("does not strip when model matches but effort is below threshold", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("low");
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerModelSelectHandler(pi);
		const handler = captured.events.get("model_select")?.[0];
		const ctx = createMockCtx({ hasUI: true });
		await handler?.({ model: modelBlocked, previousModel: modelA, source: "set" } as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("registerThinkingLevelSelectHandler", () => {
	it("strips advisor when effort rises above threshold", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		registerThinkingLevelSelectHandler(pi);
		const handler = captured.events.get("thinking_level_select")?.[0];
		const ctx = createMockCtx({ hasUI: true, model: modelBlocked });
		await handler?.({ type: "thinking_level_select", level: "high", previousLevel: "low" } as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenLastCalledWith([]);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("disabled for"), "info");
	});

	it("re-adds advisor when effort drops below threshold", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		registerThinkingLevelSelectHandler(pi);
		const handler = captured.events.get("thinking_level_select")?.[0];
		const ctx = createMockCtx({ hasUI: true, model: modelBlocked });
		await handler?.({ type: "thinking_level_select", level: "low", previousLevel: "high" } as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining([ADVISOR_TOOL_NAME]));
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("restored"), "info");
	});

	it("no-ops when no advisor model is configured", async () => {
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerThinkingLevelSelectHandler(pi);
		const handler = captured.events.get("thinking_level_select")?.[0];
		const ctx = createMockCtx({ hasUI: true, model: modelBlocked });
		await handler?.({ type: "thinking_level_select", level: "high", previousLevel: "low" } as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("restoreAdvisorState — effort-aware blocklist", () => {
	it("skips tool activation when effort at threshold", async () => {
		const { writeFileSync, mkdirSync } = await import("node:fs");
		const { dirname, join } = await import("node:path");
		const configPath = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({
				modelKey: "anthropic:opus",
				disabledForModels: [{ model: "anthropic:sonnet", minEffort: "high" }],
			}),
		);

		const { pi } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("high");
		const ctx = createMockCtx({
			hasUI: true,
			model: modelBlocked,
			models: [modelA],
		});
		restoreAdvisorState(ctx as never, pi);
		expect(getAdvisorModel()).toBe(modelA);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("activates tool when effort below threshold", async () => {
		const { writeFileSync, mkdirSync } = await import("node:fs");
		const { dirname, join } = await import("node:path");
		const configPath = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({
				modelKey: "anthropic:opus",
				disabledForModels: [{ model: "anthropic:sonnet", minEffort: "high" }],
			}),
		);

		const { pi } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("low");
		const ctx = createMockCtx({
			hasUI: true,
			model: modelBlocked,
			models: [modelA],
		});
		restoreAdvisorState(ctx as never, pi);
		expect(getAdvisorModel()).toBe(modelA);
		expect(pi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining([ADVISOR_TOOL_NAME]));
	});
});

// ── Additional model for route tests ─────────────────────────────────────────
const modelGpt = { provider: "openai", id: "gpt-5", name: "GPT-5" } as unknown as Model<Api>;

// ── Scope picker ──────────────────────────────────────────────────────────────

describe("/advisor — scope picker", () => {
	it("null scope → no-op (no other pickers called, no notify)", async () => {
		vi.mocked(showScopePicker).mockResolvedValueOnce(null);
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(showAdvisorPicker).not.toHaveBeenCalled();
		expect(showRouteListPicker).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("SCOPE_DEFAULT routes to showAdvisorPicker", async () => {
		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_DEFAULT);
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce(null);
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(showAdvisorPicker).toHaveBeenCalledOnce();
		expect(showRouteListPicker).not.toHaveBeenCalled();
	});

	it("SCOPE_ROUTES routes to showRouteListPicker", async () => {
		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce(null);
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(showRouteListPicker).toHaveBeenCalledOnce();
		expect(showAdvisorPicker).not.toHaveBeenCalled();
	});
});

// ── Routes — add route ────────────────────────────────────────────────────────

describe("/advisor — routes — add route", () => {
	it("non-reasoning advisor: saves route, no effort picker, notifies", async () => {
		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce(ADD_ROUTE_VALUE);
		vi.mocked(showRouteExecutorPicker).mockResolvedValueOnce("anthropic:opus");
		vi.mocked(showRouteAdvisorPicker).mockResolvedValueOnce("anthropic:opus");
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		const route = findPerExecutorOverride(modelA);
		expect(route).toMatchObject({ executor: "anthropic:opus", advisor: "anthropic:opus" });
		expect(route?.effort).toBeUndefined();
		expect(showRouteEffortPicker).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Route saved"), "info");
	});

	it("reasoning advisor + level: saves entry with effort", async () => {
		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce(ADD_ROUTE_VALUE);
		vi.mocked(showRouteExecutorPicker).mockResolvedValueOnce("anthropic:opus");
		vi.mocked(showRouteAdvisorPicker).mockResolvedValueOnce("anthropic:opus-thinking");
		vi.mocked(showRouteEffortPicker).mockResolvedValueOnce("medium");
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA, modelR] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		const route = findPerExecutorOverride(modelA);
		expect(route).toMatchObject({ executor: "anthropic:opus", advisor: "anthropic:opus-thinking", effort: "medium" });
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("medium"), "info");
	});

	it("inherit omits effort from entry and shows '(inherit)' in notification", async () => {
		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce(ADD_ROUTE_VALUE);
		vi.mocked(showRouteExecutorPicker).mockResolvedValueOnce("anthropic:opus");
		vi.mocked(showRouteAdvisorPicker).mockResolvedValueOnce("anthropic:opus-thinking");
		vi.mocked(showRouteEffortPicker).mockResolvedValueOnce(INHERIT_VALUE);
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA, modelR] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		const route = findPerExecutorOverride(modelA);
		expect(route).toBeDefined();
		expect(route?.effort).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("(inherit)"), "info");
	});

	it("executor picker items do NOT include the No-advisor sentinel", async () => {
		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce(ADD_ROUTE_VALUE);
		vi.mocked(showRouteExecutorPicker).mockResolvedValueOnce(null); // cancel
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA, modelR] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		const [, items] = vi.mocked(showRouteExecutorPicker).mock.calls[0] as [unknown, { value: string }[]];
		expect(items.every((item) => item.value !== NO_ADVISOR_VALUE)).toBe(true);
	});

	it("advisor picker items do NOT include the No-advisor sentinel", async () => {
		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce(ADD_ROUTE_VALUE);
		vi.mocked(showRouteExecutorPicker).mockResolvedValueOnce("anthropic:opus");
		vi.mocked(showRouteAdvisorPicker).mockResolvedValueOnce(null); // cancel
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA, modelR] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		const [, items] = vi.mocked(showRouteAdvisorPicker).mock.calls[0] as [unknown, { value: string }[]];
		expect(items.every((item) => item.value !== NO_ADVISOR_VALUE)).toBe(true);
	});

	it("cancel executor picker → no-op", async () => {
		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce(ADD_ROUTE_VALUE);
		vi.mocked(showRouteExecutorPicker).mockResolvedValueOnce(null);
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(findPerExecutorOverride(modelA)).toBeUndefined();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("cancel advisor picker → no-op", async () => {
		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce(ADD_ROUTE_VALUE);
		vi.mocked(showRouteExecutorPicker).mockResolvedValueOnce("anthropic:opus");
		vi.mocked(showRouteAdvisorPicker).mockResolvedValueOnce(null);
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(findPerExecutorOverride(modelA)).toBeUndefined();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("cancel effort picker → no-op", async () => {
		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce(ADD_ROUTE_VALUE);
		vi.mocked(showRouteExecutorPicker).mockResolvedValueOnce("anthropic:opus");
		vi.mocked(showRouteAdvisorPicker).mockResolvedValueOnce("anthropic:opus-thinking");
		vi.mocked(showRouteEffortPicker).mockResolvedValueOnce(null);
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA, modelR] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(findPerExecutorOverride(modelA)).toBeUndefined();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});

// ── Routes — edit route ───────────────────────────────────────────────────────

describe("/advisor — routes — edit route", () => {
	it("edit action re-runs full flow and upserts in place (preserves order)", async () => {
		const { readFileSync: rfs, mkdirSync: mds, writeFileSync: wfs } = await import("node:fs");
		const { dirname: dn, join: j } = await import("node:path");
		const cfgPath = j(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mds(dn(cfgPath), { recursive: true });
		wfs(
			cfgPath,
			JSON.stringify({
				perExecutor: [
					{ executor: "anthropic:opus", advisor: "openai:gpt-5" },
					{ executor: "openai:gpt-5", advisor: "anthropic:opus" },
				],
			}),
		);

		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce("anthropic:opus"); // select first route
		vi.mocked(showRouteActionPicker).mockResolvedValueOnce("edit");
		vi.mocked(showRouteExecutorPicker).mockResolvedValueOnce("anthropic:opus"); // keep executor
		vi.mocked(showRouteAdvisorPicker).mockResolvedValueOnce("anthropic:opus-thinking"); // change advisor
		vi.mocked(showRouteEffortPicker).mockResolvedValueOnce("medium");

		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA, modelR, modelGpt] });
		await captured.commands.get("advisor")?.handler("", ctx as never);

		const saved = JSON.parse(rfs(cfgPath, "utf-8"));
		expect(saved.perExecutor).toHaveLength(2);
		expect(saved.perExecutor[0]).toMatchObject({
			executor: "anthropic:opus",
			advisor: "anthropic:opus-thinking",
			effort: "medium",
		});
		expect(saved.perExecutor[1].executor).toBe("openai:gpt-5"); // second untouched
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Route saved"), "info");
	});

	it("cancel action picker → no-op", async () => {
		const { mkdirSync: mds, writeFileSync: wfs } = await import("node:fs");
		const { dirname: dn, join: j } = await import("node:path");
		const cfgPath = j(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mds(dn(cfgPath), { recursive: true });
		wfs(cfgPath, JSON.stringify({ perExecutor: [{ executor: "anthropic:opus", advisor: "openai:gpt-5" }] }));

		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce("anthropic:opus");
		vi.mocked(showRouteActionPicker).mockResolvedValueOnce(null);

		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA, modelGpt] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});

// ── Routes — remove route ─────────────────────────────────────────────────────

describe("/advisor — routes — remove route", () => {
	it("remove action saves without the entry and notifies", async () => {
		const { mkdirSync: mds, writeFileSync: wfs } = await import("node:fs");
		const { dirname: dn, join: j } = await import("node:path");
		const cfgPath = j(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mds(dn(cfgPath), { recursive: true });
		wfs(
			cfgPath,
			JSON.stringify({
				perExecutor: [
					{ executor: "anthropic:opus", advisor: "openai:gpt-5" },
					{ executor: "openai:gpt-5", advisor: "anthropic:opus" },
				],
			}),
		);

		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce("anthropic:opus");
		vi.mocked(showRouteActionPicker).mockResolvedValueOnce(REMOVE_VALUE);

		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA, modelGpt] });
		await captured.commands.get("advisor")?.handler("", ctx as never);

		// In-memory cache must not have the removed entry
		expect(findPerExecutorOverride(modelA)).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Route removed"), "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("anthropic:opus"), "info");
	});

	it("findPerExecutorOverride returns undefined immediately after remove (cache updated)", async () => {
		savePerExecutor([{ executor: "anthropic:opus", advisor: "openai:gpt-5" }]);

		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce("anthropic:opus");
		vi.mocked(showRouteActionPicker).mockResolvedValueOnce(REMOVE_VALUE);

		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA, modelGpt] });
		await captured.commands.get("advisor")?.handler("", ctx as never);

		expect(findPerExecutorOverride(modelA)).toBeUndefined();
	});
});

// ── Routes — loop back to list ───────────────────────────────────────────────

describe("/advisor — routes — loop back to list", () => {
	it("removing a route returns to the list; a second route can be removed in one pass", async () => {
		savePerExecutor([
			{ executor: "anthropic:opus", advisor: "openai:gpt-5" },
			{ executor: "openai:gpt-5", advisor: "anthropic:opus" },
		]);

		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker)
			.mockResolvedValueOnce("anthropic:opus") // remove first route
			.mockResolvedValueOnce("openai:gpt-5") // then remove second route
			.mockResolvedValueOnce(null); // then exit
		vi.mocked(showRouteActionPicker).mockResolvedValueOnce(REMOVE_VALUE).mockResolvedValueOnce(REMOVE_VALUE);

		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA, modelGpt] });
		await captured.commands.get("advisor")?.handler("", ctx as never);

		expect(showRouteListPicker).toHaveBeenCalledTimes(3);
		expect(findPerExecutorOverride(modelA)).toBeUndefined();
		expect(findPerExecutorOverride(modelGpt)).toBeUndefined();
		const removedNotifies = vi
			.mocked(ctx.ui.notify)
			.mock.calls.filter(([msg]) => String(msg).includes("Route removed"));
		expect(removedNotifies).toHaveLength(2);
	});

	it("the re-shown list reflects the removal (removed route absent)", async () => {
		savePerExecutor([
			{ executor: "anthropic:opus", advisor: "openai:gpt-5" },
			{ executor: "openai:gpt-5", advisor: "anthropic:opus" },
		]);

		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce("anthropic:opus").mockResolvedValueOnce(null);
		vi.mocked(showRouteActionPicker).mockResolvedValueOnce(REMOVE_VALUE);

		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA, modelGpt] });
		await captured.commands.get("advisor")?.handler("", ctx as never);

		const [, secondItems] = vi.mocked(showRouteListPicker).mock.calls[1] as [unknown, { value: string }[]];
		expect(secondItems.some((item) => item.value === "anthropic:opus")).toBe(false);
		expect(secondItems.some((item) => item.value === "openai:gpt-5")).toBe(true);
	});

	it("adding a route returns to the list instead of exiting", async () => {
		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce(ADD_ROUTE_VALUE).mockResolvedValueOnce(null);
		vi.mocked(showRouteExecutorPicker).mockResolvedValueOnce("anthropic:opus");
		vi.mocked(showRouteAdvisorPicker).mockResolvedValueOnce("anthropic:opus");

		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);

		expect(showRouteListPicker).toHaveBeenCalledTimes(2);
		// The re-shown list includes the freshly added route.
		const [, secondItems] = vi.mocked(showRouteListPicker).mock.calls[1] as [unknown, { value: string }[]];
		expect(secondItems.some((item) => item.value === "anthropic:opus")).toBe(true);
	});

	it("reset all routes returns to the (now empty) list", async () => {
		savePerExecutor([{ executor: "anthropic:opus", advisor: "openai:gpt-5" }]);

		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce(RESET_ALL_ROUTES_VALUE).mockResolvedValueOnce(null);
		vi.mocked(showRouteActionPicker).mockResolvedValueOnce(CONFIRM_RESET_VALUE);

		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA, modelGpt] });
		await captured.commands.get("advisor")?.handler("", ctx as never);

		expect(showRouteListPicker).toHaveBeenCalledTimes(2);
		const [, secondItems] = vi.mocked(showRouteListPicker).mock.calls[1] as [unknown, { value: string }[]];
		expect(secondItems.some((item) => item.value === "anthropic:opus")).toBe(false);
	});

	it("cancelling the route list exits without re-showing it", async () => {
		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce(null);

		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);

		expect(showRouteListPicker).toHaveBeenCalledOnce();
		expect(showRouteActionPicker).not.toHaveBeenCalled();
	});
});

// ── Routes — reset all ────────────────────────────────────────────────────────

describe("/advisor — routes — reset all", () => {
	it("confirm → clears all routes, notifies", async () => {
		savePerExecutor([
			{ executor: "anthropic:opus", advisor: "openai:gpt-5" },
			{ executor: "openai:gpt-5", advisor: "anthropic:opus" },
		]);

		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce(RESET_ALL_ROUTES_VALUE);
		vi.mocked(showRouteActionPicker).mockResolvedValueOnce(CONFIRM_RESET_VALUE);

		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA, modelGpt] });
		await captured.commands.get("advisor")?.handler("", ctx as never);

		expect(findPerExecutorOverride(modelA)).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cleared"), "info");
	});

	it("cancel reset → no change, no notify", async () => {
		const { readFileSync: rfs, mkdirSync: mds } = await import("node:fs");
		const { dirname: dn, join: j } = await import("node:path");
		const cfgPath = j(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mds(dn(cfgPath), { recursive: true });
		savePerExecutor([{ executor: "anthropic:opus", advisor: "openai:gpt-5" }]);

		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce(RESET_ALL_ROUTES_VALUE);
		vi.mocked(showRouteActionPicker).mockResolvedValueOnce("cancel");

		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA, modelGpt] });
		await captured.commands.get("advisor")?.handler("", ctx as never);

		// Check the config file was not modified (in-memory cache is not populated
		// by savePerExecutor alone — the command never calls setPerExecutor on cancel)
		const saved = JSON.parse(rfs(cfgPath, "utf-8"));
		expect(saved.perExecutor).toHaveLength(1);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("reset with no existing routes skips confirm picker", async () => {
		vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
		vi.mocked(showRouteListPicker).mockResolvedValueOnce(RESET_ALL_ROUTES_VALUE);
		// No routes in config → confirm picker should not be shown

		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);

		expect(showRouteActionPicker).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});

// ── Routes — persist failure (I2) ────────────────────────────────────────────

describe("/advisor — routes — persist failure (review I2)", () => {
	it("add route: save failure → notify error, cache not updated", async () => {
		if (process.platform === "win32") return;
		const { mkdirSync, rmSync } = await import("node:fs");
		const { dirname, join } = await import("node:path");
		const cfgPath = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mkdirSync(dirname(cfgPath), { recursive: true });
		mkdirSync(cfgPath, { recursive: true }); // EISDIR trick
		try {
			vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
			vi.mocked(showRouteListPicker).mockResolvedValueOnce(ADD_ROUTE_VALUE);
			vi.mocked(showRouteExecutorPicker).mockResolvedValueOnce("anthropic:opus");
			vi.mocked(showRouteAdvisorPicker).mockResolvedValueOnce("anthropic:opus");

			const { captured } = register();
			const ctx = createMockCtx({ hasUI: true, models: [modelA] });
			await captured.commands.get("advisor")?.handler("", ctx as never);

			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save"), "error");
			// Cache must remain empty — setPerExecutor not called
			expect(findPerExecutorOverride(modelA)).toBeUndefined();
		} finally {
			rmSync(cfgPath, { recursive: true, force: true });
		}
	});

	it("remove route: save failure → notify error, no Route-removed notify", async () => {
		if (process.platform === "win32") return;
		const { mkdirSync, rmSync, chmodSync, writeFileSync } = await import("node:fs");
		const { dirname, join } = await import("node:path");
		const cfgPath = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mkdirSync(dirname(cfgPath), { recursive: true });
		// Write a valid config so loadAdvisorConfig can read the routes.
		writeFileSync(
			cfgPath,
			JSON.stringify({ perExecutor: [{ executor: "anthropic:opus", advisor: "openai:gpt-5" }] }),
		);
		// Make the file read-only so saveJsonConfig fails on write while still readable.
		chmodSync(cfgPath, 0o444);
		try {
			vi.mocked(showScopePicker).mockResolvedValueOnce(SCOPE_ROUTES);
			vi.mocked(showRouteListPicker).mockResolvedValueOnce("anthropic:opus");
			vi.mocked(showRouteActionPicker).mockResolvedValueOnce(REMOVE_VALUE);

			const { captured } = register();
			const ctx = createMockCtx({ hasUI: true, models: [modelA, modelGpt] });
			await captured.commands.get("advisor")?.handler("", ctx as never);

			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save"), "error");
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Route removed"), "info");
		} finally {
			chmodSync(cfgPath, 0o600); // restore before setup.ts cleanup
			rmSync(cfgPath, { force: true });
		}
	});
});
