import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { validateDisabledForModels, validatePerExecutor } from "./advisor/config.js";
import { loadAdvisorConfig, saveAdvisorConfig, savePerExecutor } from "./advisor/index.js";

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");

beforeEach(() => {
	try {
		if (existsSync(CONFIG_PATH)) chmodSync(CONFIG_PATH, 0o600);
	} catch {}
});

describe("loadAdvisorConfig", () => {
	it("returns {} when file is absent", () => {
		expect(loadAdvisorConfig()).toEqual({});
	});
	it("returns {} on invalid JSON", () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, "{not json", "utf-8");
		expect(loadAdvisorConfig()).toEqual({});
	});
	it("loads well-formed JSON", () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, '{"modelKey":"anthropic:opus","effort":"high"}', "utf-8");
		expect(loadAdvisorConfig()).toEqual({ modelKey: "anthropic:opus", effort: "high" });
	});
	it("loads partial object", () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, '{"modelKey":"x:y"}', "utf-8");
		expect(loadAdvisorConfig()).toEqual({ modelKey: "x:y" });
	});
});

describe("saveAdvisorConfig", () => {
	it("creates parent dir recursively", () => {
		saveAdvisorConfig("anthropic:opus", "high");
		expect(existsSync(CONFIG_PATH)).toBe(true);
	});
	it("omits undefined fields", () => {
		saveAdvisorConfig("x:y", undefined);
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(parsed).toEqual({ modelKey: "x:y" });
		expect("effort" in parsed).toBe(false);
	});
	it("omits both when both undefined", () => {
		saveAdvisorConfig(undefined, undefined);
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(parsed).toEqual({});
	});
	it("writes JSON with trailing newline", () => {
		saveAdvisorConfig("x:y", "high");
		expect(readFileSync(CONFIG_PATH, "utf-8").endsWith("\n")).toBe(true);
	});
	it.skipIf(process.platform === "win32")("chmods the file to 0600", () => {
		saveAdvisorConfig("x:y", "high");
		const mode = statSync(CONFIG_PATH).mode & 0o777;
		expect(mode).toBe(0o600);
	});
	it("round-trips through loadAdvisorConfig", () => {
		saveAdvisorConfig("a:b", "low");
		expect(loadAdvisorConfig()).toEqual({ modelKey: "a:b", effort: "low" });
	});
});

describe("validateDisabledForModels", () => {
	it("returns [] when input is not an array", () => {
		expect(validateDisabledForModels(undefined)).toEqual([]);
		expect(validateDisabledForModels(null)).toEqual([]);
		expect(validateDisabledForModels("anthropic:opus")).toEqual([]);
		expect(validateDisabledForModels({ model: "anthropic:opus" })).toEqual([]);
	});

	it("keeps non-empty string entries", () => {
		expect(validateDisabledForModels(["anthropic:opus", "openai:gpt"])).toEqual(["anthropic:opus", "openai:gpt"]);
	});

	it("drops empty-string entries", () => {
		expect(validateDisabledForModels(["", "anthropic:opus"])).toEqual(["anthropic:opus"]);
	});

	it("keeps object entries with valid model and no minEffort", () => {
		expect(validateDisabledForModels([{ model: "anthropic:opus" }])).toEqual([{ model: "anthropic:opus" }]);
	});

	it("keeps object entries with valid minEffort from EFFORT_ORDINAL", () => {
		expect(
			validateDisabledForModels([
				{ model: "anthropic:opus", minEffort: "minimal" },
				{ model: "anthropic:opus", minEffort: "xhigh" },
			]),
		).toEqual([
			{ model: "anthropic:opus", minEffort: "minimal" },
			{ model: "anthropic:opus", minEffort: "xhigh" },
		]);
	});

	it("drops object entries with empty model", () => {
		expect(validateDisabledForModels([{ model: "" }])).toEqual([]);
	});

	it("drops object entries with non-string model", () => {
		expect(validateDisabledForModels([{ model: 42 }])).toEqual([]);
	});

	it("drops object entries with invalid minEffort", () => {
		expect(validateDisabledForModels([{ model: "anthropic:opus", minEffort: "bogus" }])).toEqual([]);
	});

	it("drops null and non-object entries", () => {
		expect(validateDisabledForModels([null, 42, true, undefined, "anthropic:opus"])).toEqual(["anthropic:opus"]);
	});

	it("preserves order of valid entries while dropping invalid", () => {
		expect(
			validateDisabledForModels([
				"anthropic:opus",
				{ model: "" },
				{ model: "anthropic:sonnet", minEffort: "high" },
				"openai:gpt",
			]),
		).toEqual(["anthropic:opus", { model: "anthropic:sonnet", minEffort: "high" }, "openai:gpt"]);
	});
});

describe("validatePerExecutor", () => {
	it("returns [] when input is not an array", () => {
		expect(validatePerExecutor(undefined)).toEqual([]);
		expect(validatePerExecutor(null)).toEqual([]);
		expect(validatePerExecutor("anthropic:opus")).toEqual([]);
		expect(validatePerExecutor({ executor: "a:b", advisor: "c:d" })).toEqual([]);
	});

	it("keeps entries with non-empty executor + advisor and no effort", () => {
		expect(validatePerExecutor([{ executor: "anthropic:opus", advisor: "openai:gpt-5.5" }])).toEqual([
			{ executor: "anthropic:opus", advisor: "openai:gpt-5.5" },
		]);
	});

	it("keeps entries with valid effort from EFFORT_ORDINAL", () => {
		expect(
			validatePerExecutor([
				{ executor: "anthropic:opus", advisor: "openai:gpt-5.5", effort: "minimal" },
				{ executor: "openai:gpt-5.5", advisor: "anthropic:opus", effort: "xhigh" },
			]),
		).toEqual([
			{ executor: "anthropic:opus", advisor: "openai:gpt-5.5", effort: "minimal" },
			{ executor: "openai:gpt-5.5", advisor: "anthropic:opus", effort: "xhigh" },
		]);
	});

	it("drops entries with invalid effort", () => {
		expect(validatePerExecutor([{ executor: "a:b", advisor: "c:d", effort: "bogus" }])).toEqual([]);
	});

	it("drops entries with empty or non-string executor", () => {
		expect(
			validatePerExecutor([
				{ executor: "", advisor: "c:d" },
				{ executor: 42, advisor: "c:d" },
			]),
		).toEqual([]);
	});

	it("drops entries with empty or non-string advisor", () => {
		expect(
			validatePerExecutor([
				{ executor: "a:b", advisor: "" },
				{ executor: "a:b", advisor: null },
			]),
		).toEqual([]);
	});

	it("drops null and non-object entries", () => {
		expect(validatePerExecutor([null, 42, true, undefined, { executor: "a:b", advisor: "c:d" }])).toEqual([
			{ executor: "a:b", advisor: "c:d" },
		]);
	});

	it("preserves order of valid entries while dropping invalid", () => {
		expect(
			validatePerExecutor([
				{ executor: "anthropic:opus", advisor: "openai:gpt-5.5", effort: "high" },
				{ executor: "", advisor: "x:y" },
				{ executor: "openai:gpt-5.5", advisor: "anthropic:opus" },
				{ executor: "google:gemini", advisor: "" },
			]),
		).toEqual([
			{ executor: "anthropic:opus", advisor: "openai:gpt-5.5", effort: "high" },
			{ executor: "openai:gpt-5.5", advisor: "anthropic:opus" },
		]);
	});
});

describe("savePerExecutor", () => {
	it("writes entries and they round-trip through loadAdvisorConfig", () => {
		const entries = [
			{ executor: "anthropic:opus", advisor: "openai:gpt-5", effort: "high" as const },
			{ executor: "openai:gpt-5", advisor: "anthropic:opus" },
		];
		expect(savePerExecutor(entries)).toBe(true);
		expect(loadAdvisorConfig().perExecutor).toEqual(entries);
	});

	it("preserves existing modelKey, effort, guidance, and disabledForModels", () => {
		saveAdvisorConfig("anthropic:opus", "medium");
		const entries = [{ executor: "openai:gpt-5", advisor: "anthropic:opus" }];
		savePerExecutor(entries);
		const cfg = loadAdvisorConfig();
		expect(cfg.modelKey).toBe("anthropic:opus");
		expect(cfg.effort).toBe("medium");
		expect(cfg.perExecutor).toEqual(entries);
	});

	it("deletes perExecutor key when entries is empty", () => {
		savePerExecutor([{ executor: "a:b", advisor: "c:d" }]);
		savePerExecutor([]);
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect("perExecutor" in parsed).toBe(false);
	});

	it("returns false on write failure (EISDIR trick)", () => {
		if (process.platform === "win32") return;
		const { mkdirSync: mkdir, rmSync } = require("node:fs");
		mkdir(CONFIG_PATH, { recursive: true });
		try {
			expect(savePerExecutor([{ executor: "a:b", advisor: "c:d" }])).toBe(false);
		} finally {
			rmSync(CONFIG_PATH, { recursive: true, force: true });
		}
	});

	it("upsert replace-in-place: updating executor keeps its position", () => {
		const initial = [
			{ executor: "anthropic:opus", advisor: "openai:gpt-5", effort: "high" as const },
			{ executor: "openai:gpt-5", advisor: "anthropic:opus" },
		];
		savePerExecutor(initial);
		// Simulate upsert: replace first entry in place
		const updated = [
			{ executor: "anthropic:opus", advisor: "anthropic:opus-thinking", effort: "medium" as const },
			{ executor: "openai:gpt-5", advisor: "anthropic:opus" },
		];
		savePerExecutor(updated);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.perExecutor[0].executor).toBe("anthropic:opus");
		expect(saved.perExecutor[0].advisor).toBe("anthropic:opus-thinking");
		expect(saved.perExecutor[0].effort).toBe("medium");
		expect(saved.perExecutor[1].executor).toBe("openai:gpt-5");
		expect(saved.perExecutor).toHaveLength(2);
	});

	it("upsert append: new executor is added at the end", () => {
		const initial = [{ executor: "anthropic:opus", advisor: "openai:gpt-5" }];
		savePerExecutor(initial);
		const appended = [...initial, { executor: "openai:gpt-5", advisor: "anthropic:opus" }];
		savePerExecutor(appended);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.perExecutor).toHaveLength(2);
		expect(saved.perExecutor[1].executor).toBe("openai:gpt-5");
	});
});
