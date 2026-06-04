/**
 * advisor-ui.routes.test.ts — panel + keyboard tests for the per-executor
 * route picker wrappers added in the feat/per-executor-advisor-routing branch:
 * showScopePicker, showRouteListPicker, showRouteExecutorPicker,
 * showRouteAdvisorPicker, showRouteEffortPicker, showRouteActionPicker.
 */
import type { SelectItem } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	showRouteActionPicker,
	showRouteAdvisorPicker,
	showRouteEffortPicker,
	showRouteExecutorPicker,
	showRouteListPicker,
	showScopePicker,
} from "./advisor-ui.js";

interface RenderableComponent {
	render: (w: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
}

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
};

function driveCustom<T>(script: (c: RenderableComponent, done: (v: T) => void) => void) {
	const requestRender = vi.fn();
	const custom = vi.fn((factory: unknown) => {
		return new Promise((resolve) => {
			const f = factory as (
				tui: { requestRender: () => void },
				theme: typeof identityTheme,
				kb: undefined,
				done: (v: unknown) => void,
			) => RenderableComponent;
			const component = f({ requestRender }, identityTheme, undefined, resolve);
			script(component, resolve as (v: T) => void);
		});
	});
	return { custom, requestRender };
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ── showScopePicker ───────────────────────────────────────────────────────────

const scopeItems: SelectItem[] = [
	{ label: "Default advisor", value: "__scope_default__" },
	{ label: "Per-executor routes", value: "__scope_routes__" },
];

describe("showScopePicker — panel layout", () => {
	it("renders without throwing", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			expect(() => c.render(80)).not.toThrow();
			done(null);
		});
		await showScopePicker({ ui: { custom } } as never, scopeItems);
	});

	it("output contains 'Advisor Tool' title", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(100).join("\n");
			expect(out).toContain("Advisor Tool");
			done(null);
		});
		await showScopePicker({ ui: { custom } } as never, scopeItems);
	});

	it("output contains scope-specific prose (not the model-picker prose)", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(120).join("\n");
			expect(out).toContain("per-executor routes");
			done(null);
		});
		await showScopePicker({ ui: { custom } } as never, scopeItems);
	});

	it("output contains both item labels", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(120).join("\n");
			expect(out).toContain("Default advisor");
			expect(out).toContain("Per-executor routes");
			done(null);
		});
		await showScopePicker({ ui: { custom } } as never, scopeItems);
	});

	it("ENTER on first item resolves with its value", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\r");
		});
		const result = await showScopePicker({ ui: { custom } } as never, scopeItems);
		expect(result).toBe("__scope_default__");
	});

	it("ESC resolves with null", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\u001b");
		});
		const result = await showScopePicker({ ui: { custom } } as never, scopeItems);
		expect(result).toBeNull();
	});

	it("DOWN then ENTER picks second item", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\u001b[B");
			c.handleInput("\r");
		});
		const result = await showScopePicker({ ui: { custom } } as never, scopeItems);
		expect(result).toBe("__scope_routes__");
	});
});

// ── showRouteListPicker ───────────────────────────────────────────────────────

const routeListItems: SelectItem[] = [
	{ label: "anthropic:opus → openai:gpt-5  [high] ✓", value: "anthropic:opus" },
	{ label: "openai:gpt-5 → anthropic:opus  [inherit] ✓", value: "openai:gpt-5" },
	{ label: "Add route", value: "__add_route__" },
	{ label: "Reset all routes", value: "__reset_all_routes__" },
];

describe("showRouteListPicker — panel layout", () => {
	it("renders without throwing", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			expect(() => c.render(100)).not.toThrow();
			done(null);
		});
		await showRouteListPicker({ ui: { custom } } as never, routeListItems);
	});

	it("output contains 'Per-Executor Routes' title", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(120).join("\n");
			expect(out).toContain("Per-Executor Routes");
			done(null);
		});
		await showRouteListPicker({ ui: { custom } } as never, routeListItems);
	});

	it("output shows route labels with effort and inherit", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(150).join("\n");
			expect(out).toContain("[high]");
			expect(out).toContain("[inherit]");
			done(null);
		});
		await showRouteListPicker({ ui: { custom } } as never, routeListItems);
	});

	it("output contains Add route and Reset all routes action items", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(120).join("\n");
			expect(out).toContain("Add route");
			expect(out).toContain("Reset all routes");
			done(null);
		});
		await showRouteListPicker({ ui: { custom } } as never, routeListItems);
	});

	it("ENTER picks first item", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\r");
		});
		const result = await showRouteListPicker({ ui: { custom } } as never, routeListItems);
		expect(result).toBe("anthropic:opus");
	});

	it("ESC resolves with null", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\u001b");
		});
		const result = await showRouteListPicker({ ui: { custom } } as never, routeListItems);
		expect(result).toBeNull();
	});
});

// ── showRouteExecutorPicker ───────────────────────────────────────────────────

const modelItems: SelectItem[] = [
	{ label: "Claude Opus  (anthropic)", value: "anthropic:opus" },
	{ label: "GPT-5  (openai)", value: "openai:gpt-5" },
];

describe("showRouteExecutorPicker — panel layout and keyboard", () => {
	it("output contains 'Choose Executor' title", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(100).join("\n");
			expect(out).toContain("Choose Executor");
			done(null);
		});
		await showRouteExecutorPicker({ ui: { custom } } as never, modelItems);
	});

	it("ENTER picks first item", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\r");
		});
		const result = await showRouteExecutorPicker({ ui: { custom } } as never, modelItems);
		expect(result).toBe("anthropic:opus");
	});

	it("ESC resolves with null", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\u001b");
		});
		const result = await showRouteExecutorPicker({ ui: { custom } } as never, modelItems);
		expect(result).toBeNull();
	});

	it("items do NOT contain a No-advisor sentinel value", async () => {
		// Verify the items passed to the executor picker (model-only items) lack sentinel
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(100).join("\n");
			expect(out).not.toContain("No advisor");
			done(null);
		});
		await showRouteExecutorPicker({ ui: { custom } } as never, modelItems);
	});
});

// ── showRouteAdvisorPicker ────────────────────────────────────────────────────

describe("showRouteAdvisorPicker — panel layout and keyboard", () => {
	it("output contains 'Choose Advisor for Route' title", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(120).join("\n");
			expect(out).toContain("Choose Advisor for Route");
			done(null);
		});
		await showRouteAdvisorPicker({ ui: { custom } } as never, modelItems);
	});

	it("ENTER picks first item", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\r");
		});
		const result = await showRouteAdvisorPicker({ ui: { custom } } as never, modelItems);
		expect(result).toBe("anthropic:opus");
	});

	it("checkmark (✓) present on preselected item", async () => {
		const itemsWithCheck: SelectItem[] = [
			{ label: "Claude Opus  (anthropic) ✓", value: "anthropic:opus" },
			{ label: "GPT-5  (openai)", value: "openai:gpt-5" },
		];
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(120).join("\n");
			expect(out).toContain("✓");
			done(null);
		});
		await showRouteAdvisorPicker({ ui: { custom } } as never, itemsWithCheck);
	});
});

// ── showRouteEffortPicker ─────────────────────────────────────────────────────

const routeEffortItems: SelectItem[] = [
	{ label: "inherit (use default)", value: "__inherit__" },
	{ label: "minimal", value: "minimal" },
	{ label: "low", value: "low" },
	{ label: "medium", value: "medium" },
	{ label: "high  (recommended)", value: "high" },
];

describe("showRouteEffortPicker — panel layout, preselection, and keyboard", () => {
	it("output contains 'Reasoning Level for Route' title", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(100).join("\n");
			expect(out).toContain("Reasoning Level for Route");
			done(null);
		});
		await showRouteEffortPicker({ ui: { custom } } as never, routeEffortItems);
	});

	it("output contains 'inherit (use default)' item and graded levels", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(100).join("\n");
			expect(out).toContain("inherit (use default)");
			expect(out).toContain("medium");
			done(null);
		});
		await showRouteEffortPicker({ ui: { custom } } as never, routeEffortItems);
	});

	it("output does NOT contain 'off' (off is not a valid route effort)", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(100).join("\n");
			expect(out).not.toContain("\noff");
			done(null);
		});
		await showRouteEffortPicker({ ui: { custom } } as never, routeEffortItems);
	});

	it("preselects INHERIT_VALUE when no preferredValue supplied — ENTER resolves with inherit", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\r");
		});
		// No preferredValue → first item (inherit) is selected by default
		const result = await showRouteEffortPicker({ ui: { custom } } as never, routeEffortItems);
		expect(result).toBe("__inherit__");
	});

	it("preselects the supplied preferredValue — ENTER resolves with it", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\r");
		});
		const result = await showRouteEffortPicker({ ui: { custom } } as never, routeEffortItems, "medium");
		expect(result).toBe("medium");
	});

	it("ESC resolves with null", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\u001b");
		});
		const result = await showRouteEffortPicker({ ui: { custom } } as never, routeEffortItems, "__inherit__");
		expect(result).toBeNull();
	});
});

// ── showRouteActionPicker ─────────────────────────────────────────────────────

const actionItems: SelectItem[] = [
	{ label: "Edit route", value: "edit" },
	{ label: "Remove route", value: "__remove_route__" },
];

describe("showRouteActionPicker — panel layout and keyboard", () => {
	it("output contains 'Route Action' title", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(100).join("\n");
			expect(out).toContain("Route Action");
			done(null);
		});
		await showRouteActionPicker({ ui: { custom } } as never, actionItems);
	});

	it("ENTER picks first item", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\r");
		});
		const result = await showRouteActionPicker({ ui: { custom } } as never, actionItems);
		expect(result).toBe("edit");
	});

	it("ESC resolves with null", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\u001b");
		});
		const result = await showRouteActionPicker({ ui: { custom } } as never, actionItems);
		expect(result).toBeNull();
	});
});
