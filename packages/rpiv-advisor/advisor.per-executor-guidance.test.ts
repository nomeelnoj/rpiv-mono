import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import {
	ADVISOR_TOOL_NAME,
	DEFAULT_PROMPT_GUIDELINES,
	DEFAULT_PROMPT_SNIPPET,
	findPerExecutorGuidance,
	refreshAdvisorToolDescription,
	registerAdvisorTool,
	setPerExecutorGuidance,
	validatePerExecutorGuidance,
} from "./advisor/index.js";

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");

function writeConfig(data: Record<string, unknown>): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
}

const SOL = "llm-router:gpt-5.6-sol";
const TERRA = "llm-router:gpt-5.6-terra";
const LUNA = "llm-router:gpt-5.6-luna";

describe("validatePerExecutorGuidance", () => {
	it("keeps a valid grouped entry", () => {
		const out = validatePerExecutorGuidance([
			{ models: [SOL, TERRA, LUNA], guidance: { promptGuidelines: ["Never first"] } },
		]);
		expect(out).toEqual([{ models: [SOL, TERRA, LUNA], guidance: { promptGuidelines: ["Never first"] } }]);
	});

	it("returns [] for non-array input", () => {
		expect(validatePerExecutorGuidance(undefined)).toEqual([]);
		expect(validatePerExecutorGuidance({})).toEqual([]);
	});

	it("drops entries with no valid model keys", () => {
		expect(validatePerExecutorGuidance([{ models: [], guidance: { promptSnippet: "x" } }])).toEqual([]);
		expect(validatePerExecutorGuidance([{ models: [123, ""], guidance: { promptSnippet: "x" } }])).toEqual([]);
	});

	it("filters non-string model keys but keeps valid ones", () => {
		const out = validatePerExecutorGuidance([{ models: [SOL, 5, ""], guidance: { promptSnippet: "x" } }]);
		expect(out).toEqual([{ models: [SOL], guidance: { promptSnippet: "x" } }]);
	});

	it("drops entries whose guidance sets no usable field", () => {
		expect(validatePerExecutorGuidance([{ models: [SOL], guidance: {} }])).toEqual([]);
		expect(validatePerExecutorGuidance([{ models: [SOL], guidance: { promptGuidelines: [] } }])).toEqual([]);
		expect(validatePerExecutorGuidance([{ models: [SOL], guidance: { promptSnippet: "" } }])).toEqual([]);
	});

	it("preserves input order across multiple groups", () => {
		const out = validatePerExecutorGuidance([
			{ models: [SOL], guidance: { promptSnippet: "a" } },
			{ models: [TERRA], guidance: { promptSnippet: "b" } },
		]);
		expect(out.map((e) => e.models[0])).toEqual([SOL, TERRA]);
	});
});

describe("findPerExecutorGuidance", () => {
	it("returns the guidance for a matching executor key", () => {
		setPerExecutorGuidance([{ models: [SOL, TERRA, LUNA], guidance: { promptSnippet: "grouped" } }]);
		expect(findPerExecutorGuidance(TERRA)).toEqual({ promptSnippet: "grouped" });
	});

	it("returns undefined for no key or no match", () => {
		setPerExecutorGuidance([{ models: [SOL], guidance: { promptSnippet: "x" } }]);
		expect(findPerExecutorGuidance(undefined)).toBeUndefined();
		expect(findPerExecutorGuidance("anthropic:claude-opus-4-8")).toBeUndefined();
	});

	it("returns the first matching group when keys overlap", () => {
		setPerExecutorGuidance([
			{ models: [SOL], guidance: { promptSnippet: "first" } },
			{ models: [SOL], guidance: { promptSnippet: "second" } },
		]);
		expect(findPerExecutorGuidance(SOL)).toEqual({ promptSnippet: "first" });
	});
});

describe("registerAdvisorTool — per-executor guidance resolution", () => {
	it("applies a matching executor's guidelines over the defaults", () => {
		setPerExecutorGuidance([
			{ models: [SOL, TERRA, LUNA], guidance: { promptGuidelines: ["NEVER call advisor first"] } },
		]);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi, undefined, SOL);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptGuidelines).toEqual(["NEVER call advisor first"]);
		// Field not set by the override falls through to the built-in default.
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
	});

	it("field-merges over global guidance: override guidelines, global snippet", () => {
		writeConfig({ guidance: { promptSnippet: "global snippet", promptGuidelines: ["global rule"] } });
		setPerExecutorGuidance([{ models: [SOL], guidance: { promptGuidelines: ["sol rule"] } }]);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi, undefined, SOL);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptGuidelines).toEqual(["sol rule"]);
		expect(tool.promptSnippet).toBe("global snippet");
	});

	it("falls back to global guidance when the executor has no override", () => {
		writeConfig({ guidance: { promptGuidelines: ["global rule"] } });
		setPerExecutorGuidance([{ models: [SOL], guidance: { promptGuidelines: ["sol rule"] } }]);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi, undefined, "anthropic:claude-opus-4-8");
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptGuidelines).toEqual(["global rule"]);
	});

	it("falls back to defaults by reference when no executor key and no config", () => {
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
		expect(tool.promptGuidelines).toBe(DEFAULT_PROMPT_GUIDELINES);
	});
});

describe("refreshAdvisorToolDescription — guidance change guard", () => {
	it("re-registers when switching to an executor with different guidance", () => {
		setPerExecutorGuidance([{ models: [SOL], guidance: { promptGuidelines: ["sol rule"] } }]);
		const { pi, captured } = createMockPi();
		// Baseline: an executor with no override uses the built-in defaults.
		registerAdvisorTool(pi, undefined, "anthropic:claude-opus-4-8");
		expect(captured.tools.get(ADVISOR_TOOL_NAME)!.promptGuidelines).toBe(DEFAULT_PROMPT_GUIDELINES);
		// Switching to SOL (same description, different guidance) must re-register.
		refreshAdvisorToolDescription(pi, undefined, SOL);
		expect(captured.tools.get(ADVISOR_TOOL_NAME)!.promptGuidelines).toEqual(["sol rule"]);
	});
});
