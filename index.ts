/**
 * AgentDiet — trajectory reduction for Pi.
 *
 * Ports "Reducing Cost of LLM Agents with Trajectory Reduction" (FSE 2026,
 * arXiv:2509.23586, artifact github.com/xywen97/Costdown). A cheap reflector model
 * rewrites an older trajectory step so the agent carries less dead weight forward.
 *
 * Two deliberate departures from the paper, both forced by Pi's data model:
 *
 * 1. The paper overwrites the step destructively. We append a `context_edit` entry
 *    instead, so raw history, UI, exports and billing are untouched and the latest
 *    edit per target wins (structural idempotency, no marker needed).
 * 2. The paper compresses a whole step (think + call + result). We only ever rewrite
 *    toolResult entries. String-replacing an assistant entry would collapse its
 *    content array to one text block, destroying its toolCall blocks and orphaning
 *    every paired result. `replaceToolResult` carries the matching omission hazard.
 *
 * Disabled by default. Enable with `/diet on`.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { AssistantMessage, TextContent, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { estimateTokens, getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	ContextEditEntryDraft,
	CustomEntryDraft,
	ExtensionAPI,
	ExtensionContext,
	ProjectedSessionEntry,
	SessionBoundaryDraft,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Compressing these poisons later work: `edit` matches oldString against text the
// model read verbatim, and `write` echoes content it may re-quote. Search output is
// eligible because its source links and claims can be retained in a shorter result.
const NEVER_COMPRESS = new Set(["read", "edit", "write"]);

// The provider must let Pi own the message array. Under `cursor` the SDK fingerprints
// every message and re-bootstraps the whole conversation when any earlier one changes,
// so a diet there costs more than it saves.
const SUPPORTED_PROVIDERS = new Set(["openai-codex"]);

// Gate 2, verbatim from the artifact: accept if it saved 400+ tokens OR cut at least 20%.
const ABSOLUTE_SAVING_TOKENS = 400;
const RELATIVE_SAVING_RATIO = 0.8;

const REFLECTOR_TIMEOUT_MS = 20_000;
// A 20-50% compression of a large step needs room: too low a cap truncates the reply,
// the closing </result> never arrives, and the reflection is discarded as unparseable.
const REFLECTOR_MAX_TOKENS = 8192;

interface DietConfig {
	enabled: boolean;
	/** Lag. Never 0 — the ablation puts pass rate at 59 vs 65 with no lag. */
	a: number;
	/** Neighbour steps shown before the target. */
	b: number;
	/** Gate 1: skip targets smaller than this many tokens. */
	theta: number;
	reflectorModel: string;
}

const DEFAULTS: DietConfig = {
	enabled: false,
	a: 2,
	b: 1,
	theta: 500,
	reflectorModel: "openai-codex/gpt-5.6-luna",
};

interface StepTool {
	entryId: string;
	toolCallId: string;
	toolName: string;
	isError: boolean;
	tokens: number;
	text: string;
}

interface Step {
	assistantEntryId: string;
	tools: StepTool[];
	tokens: number;
}

interface DietRecord {
	step: number;
	targetIds: string[];
	tokensBefore: number;
	tokensAfter: number;
	track: "supersession" | "reflection";
	model?: string;
	usage?: Usage;
}

function configPath(): string {
	return join(getAgentDir(), "agentdiet.json");
}

function loadConfig(): DietConfig {
	let stored: Partial<DietConfig> = {};
	try {
		stored = JSON.parse(readFileSync(configPath(), "utf-8")) as Partial<DietConfig>;
	} catch {
		return { ...DEFAULTS };
	}
	return {
		enabled: stored.enabled ?? DEFAULTS.enabled,
		a: clamp(stored.a ?? DEFAULTS.a, 1, 5),
		b: clamp(stored.b ?? DEFAULTS.b, 0, 3),
		theta: clamp(stored.theta ?? DEFAULTS.theta, 100, 20_000),
		reflectorModel: stored.reflectorModel ?? DEFAULTS.reflectorModel,
	};
}

function saveConfig(config: DietConfig): void {
	writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.round(value)));
}

function textOf(content: ToolResultMessage["content"]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * A step is one assistant message plus the tool results that follow it. Built from the
 * boundary's projected entries so `s` renumbers against live context after a compaction.
 *
 * Never derived from `event.turnIndex`: that resets to 0 on every agent_start, which
 * would silently collapse the lag to a=0.
 */
export function collectSteps(entries: ProjectedSessionEntry[]): Step[] {
	const steps: Step[] = [];
	let current: Step | undefined;

	for (const projected of entries) {
		const source = projected.sourceEntry;
		if (source.type !== "message") continue;
		const message = (source as SessionMessageEntry).message;

		if (message.role === "assistant") {
			current = { assistantEntryId: source.id, tools: [], tokens: estimateTokens(message) };
			steps.push(current);
			continue;
		}

		if (message.role === "toolResult" && current) {
			const result = message as ToolResultMessage;
			current.tools.push({
				entryId: source.id,
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				isError: result.isError,
				tokens: estimateTokens(message),
				text: textOf(result.content),
			});
			current.tokens += estimateTokens(message);
			continue;
		}

		// A user message or any summary entry closes the step.
		current = undefined;
	}

	return steps;
}

export function compressibleTools(step: Step): StepTool[] {
	// Errors stay verbatim: short, load-bearing, and often re-quoted.
	return step.tools.filter(
		(tool) => !NEVER_COMPRESS.has(tool.toolName) && !tool.isError && tool.text.length > 0,
	);
}

interface ReadCall {
	path: string;
	/** A ranged read cannot be superseded by a different range. */
	whole: boolean;
}

function readCallsOf(ctx: ExtensionContext, assistantEntryId: string): Map<string, ReadCall> {
	const calls = new Map<string, ReadCall>();
	const entry = ctx.sessionManager.getEntry(assistantEntryId);
	if (!entry || entry.type !== "message") return calls;

	const message = (entry as SessionMessageEntry).message;
	if (message.role !== "assistant") return calls;

	for (const block of (message as AssistantMessage).content) {
		if (block.type !== "toolCall" || block.name !== "read") continue;
		const args = block.arguments as { path?: unknown; offset?: unknown; limit?: unknown };
		if (typeof args?.path !== "string") continue;
		// The read tool uses constrained JSON-schema sampling, so models routinely emit
		// every property rather than omitting the optional ones: {offset: 1, limit: null}
		// is the common spelling of "whole file". Treating only `undefined` as unset here
		// means nothing is ever recognised as a full read.
		const startsAtTop = args.offset === undefined || args.offset === null || args.offset === 1;
		const unbounded = args.limit === undefined || args.limit === null;
		calls.set(block.id, {
			path: resolve(ctx.cwd, args.path),
			whole: startsAtTop && unbounded,
		});
	}

	return calls;
}

/**
 * Track A. A read of a path that is later re-read in full is provably redundant: the
 * model has fresher verbatim text, so replacing the old one cannot break a later edit.
 * No LLM, no judgement.
 */
export function supersededReads(
	ctx: ExtensionContext,
	steps: Step[],
	cutoff: number,
): { entryId: string; path: string; tokens: number }[] {
	const reads: { stepIndex: number; entryId: string; path: string; whole: boolean; tokens: number }[] = [];

	steps.forEach((step, stepIndex) => {
		const calls = readCallsOf(ctx, step.assistantEntryId);
		for (const tool of step.tools) {
			if (tool.toolName !== "read" || tool.isError) continue;
			const call = calls.get(tool.toolCallId);
			if (!call) continue;
			reads.push({ stepIndex, entryId: tool.entryId, path: call.path, whole: call.whole, tokens: tool.tokens });
		}
	});

	const lastWholeRead = new Map<string, number>();
	reads.forEach((read, index) => {
		if (read.whole) lastWholeRead.set(read.path, index);
	});

	const superseded: { entryId: string; path: string; tokens: number; stepIndex: number }[] = [];
	reads.forEach((read, index) => {
		if (read.stepIndex > cutoff) return;
		const latest = lastWholeRead.get(read.path);
		if (latest === undefined || latest <= index) return;
		superseded.push({ entryId: read.entryId, path: read.path, tokens: read.tokens, stepIndex: read.stepIndex });
	});

	return superseded;
}

function alreadyEdited(ctx: ExtensionContext): Set<string> {
	const edited = new Set<string>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "context_edit") edited.add(entry.targetId);
	}
	return edited;
}

/**
 * NEVER_NULL: `replacement: null` deletes the message outright, orphaning the toolCall
 * block still sitting in the preceding assistant message. Pi's own omission path always
 * drops the assistant message and its results as a set. We only ever replace.
 */
function replaceToolResult(entryId: string, text: string, original: ToolResultMessage): ContextEditEntryDraft {
	const images = original.content.filter((block) => block.type === "image");
	return {
		type: "context_edit",
		targetId: entryId,
		replacement: { content: [{ type: "text", text }, ...images] as ToolResultMessage["content"] },
	};
}

function toolResultAt(ctx: ExtensionContext, entryId: string): ToolResultMessage | undefined {
	const entry = ctx.sessionManager.getEntry(entryId);
	if (!entry || entry.type !== "message") return undefined;
	const message = (entry as SessionMessageEntry).message;
	return message.role === "toolResult" ? (message as ToolResultMessage) : undefined;
}

// Verbatim from Costdown code/trae_agent/agents/traj_analyzer.py, with only the tag
// vocabulary changed to match what we actually render. The 20%-50% target is the
// anti-aggressiveness guard the ablation demands; do not soften it to "be concise".
const SYS_PROMPT = `
You will analyze and compress a given step in a trajectory of an AI agent solving a software bug.

In the trajectory, each step is marked in <step id="..."></step>.
The agent calls external tools; each tool's output is marked in <result id="..." tool="..."></result> within the <step> tag.

Your job is to compress the text within the given id to avoid harming efficiency, typically shortening it to 20%-50% of the original length.
Meanwhile, keep the compressed text useful such that you are able to continue the trajectory as close as the original path.

- You should ONLY remove redundant texts, which are either irrelevant to future steps or duplicated by other texts in the trajectory.
- Replace the text to remove to "..." and a short takeaway, e.g. "... (same as the content below)".
- You should keep the original structure unchanged, e.g., XML tags, Python indentation and line numbers.
- Again, keep useful details in the original content unchanged, e.g., XML tags, Python indentation and line numbers.
- For a web_search result, retain each source URL, title, and the claim it supports. Do not turn attributed facts into unattributed summaries.

Typical examples:
- If the step opens a huge file but only one part is necessary for future steps, replace other parts to "... (unrelated function XXX, YYY)".
- If the step runs a verbose test script and everything goes fine, replace the verbose part to "... (expected output)".

Reproduce every <result> tag of the target step with its id attribute unchanged, containing only the compressed text.
You should only process the text within the <step> tag with the given id. STOP OUTPUT IMMEDIATELY AFTER </step>.
`.trim();

function renderStep(step: Step, index: number, compressibleOnly: boolean): string {
	const tools = compressibleOnly ? compressibleTools(step) : step.tools;
	const results = tools
		.map((tool) => `<result id="${tool.toolCallId}" tool="${tool.toolName}">\n${tool.text}\n</result>`)
		.join("\n");
	return `<step id="${index}">\n${results}\n</step>`;
}

export function parseCompressed(raw: string): Map<string, string> {
	// The artifact uses stop='</step>'. Pi's StreamOptions has no stop field, so we cut
	// at the first closing tag ourselves.
	const [body] = raw.split("</step>");
	const compressed = new Map<string, string>();
	const pattern = /<result\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/result>/g;

	let match = pattern.exec(body);
	while (match) {
		compressed.set(match[1], match[2].trim());
		match = pattern.exec(body);
	}

	return compressed;
}

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	let notified = false;
	const stats = { steps: 0, events: 0, tokensSaved: 0, reflectorCalls: 0, reflectorCost: 0 };

	const providerVerdict = (ctx: ExtensionContext): { ok: boolean; reason?: string } => {
		const provider = ctx.model?.provider;
		if (!provider) return { ok: false, reason: "no active model" };
		if (SUPPORTED_PROVIDERS.has(provider)) return { ok: true };
		if (provider === "cursor") {
			return {
				ok: false,
				reason:
					'active provider is "cursor". The Cursor SDK fingerprints every message and re-bootstraps the entire conversation when any earlier one changes, so trajectory reduction would increase cost, not reduce it. Switch to openai-codex with /model.',
			};
		}
		return { ok: false, reason: `provider "${provider}" is untested for trajectory reduction` };
	};

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		if (notified || !ctx.hasUI) return;
		notified = true;

		if (!config.enabled) {
			ctx.ui.notify("agentdiet: loaded, disabled. Enable with /diet on.", "info");
			return;
		}
		const verdict = providerVerdict(ctx);
		if (!verdict.ok) {
			ctx.ui.notify(`agentdiet: disabled — ${verdict.reason}`, "warning");
			return;
		}
		ctx.ui.notify(
			`agentdiet: active (a=${config.a} b=${config.b} theta=${config.theta}, reflector ${config.reflectorModel})`,
			"info",
		);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!config.enabled) return;
		if (event.outcome !== "completed") return;
		if (!providerVerdict(ctx).ok) return;

		try {
			const drafts = await planDiet(event, ctx);
			if (drafts.length === 0) return;
			return { entries: [...event.entries, ...drafts] };
		} catch (error) {
			// A malformed draft batch makes Pi discard every extension's drafts for this
			// turn, so failures must stay contained here. Always log to stderr as well:
			// notify() is a no-op outside the TUI, and a diet that silently does nothing
			// is indistinguishable from one that is working.
			const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
			console.error(`agentdiet: skipped this turn — ${detail}`);
			if (ctx.hasUI) ctx.ui.notify(`agentdiet: skipped this turn — ${detail.split("\n")[0]}`, "warning");
			return;
		}
	});

	async function planDiet(
		event: { context: { contextEntries: ProjectedSessionEntry[] }; messageEntryId: string },
		ctx: ExtensionContext,
	): Promise<SessionBoundaryDraft[]> {
		const steps = collectSteps(event.context.contextEntries);
		const s = steps.length - 1;
		if (s < 0) return [];
		if (steps[s].assistantEntryId !== event.messageEntryId) return [];
		stats.steps = Math.max(stats.steps, steps.length);

		// The artifact's guard: turn < N_CTX_BEFORE + N_CTX_AFTER.
		if (s < config.a + config.b) return [];

		const edited = alreadyEdited(ctx);
		const drafts: SessionBoundaryDraft[] = [];

		// Track A runs every turn and is free.
		const supersededIds: string[] = [];
		let supersededTokens = 0;
		for (const read of supersededReads(ctx, steps, s - config.a)) {
			if (edited.has(read.entryId)) continue;
			const original = toolResultAt(ctx, read.entryId);
			if (!original) continue;
			drafts.push(replaceToolResult(read.entryId, `[superseded by a later full read of ${read.path}]`, original));
			edited.add(read.entryId);
			supersededIds.push(read.entryId);
			supersededTokens += read.tokens;
		}
		if (supersededIds.length > 0) {
			stats.events += 1;
			stats.tokensSaved += supersededTokens;
			drafts.push(bookkeeping({
				step: s - config.a,
				targetIds: supersededIds,
				tokensBefore: supersededTokens,
				tokensAfter: 0,
				track: "supersession",
			}));
		}

		const target = steps[s - config.a];
		const targets = compressibleTools(target).filter((tool) => !edited.has(tool.entryId));
		if (targets.length === 0) return drafts;

		const tokensBefore = targets.reduce((sum, tool) => sum + tool.tokens, 0);
		if (tokensBefore < config.theta) return drafts; // Gate 1

		const reflection = await reflect(ctx, steps, s, targets);
		if (!reflection) return drafts;

		const rewrites: ContextEditEntryDraft[] = [];
		let tokensAfter = 0;
		for (const tool of targets) {
			const compressed = reflection.compressed.get(tool.toolCallId);
			if (compressed === undefined || compressed.length === 0) {
				tokensAfter += tool.tokens;
				continue;
			}
			const original = toolResultAt(ctx, tool.entryId);
			if (!original) {
				tokensAfter += tool.tokens;
				continue;
			}
			rewrites.push(replaceToolResult(tool.entryId, compressed, original));
			tokensAfter += Math.ceil(compressed.length / 4);
		}

		stats.reflectorCalls += 1;
		stats.reflectorCost += reflection.usage?.cost?.total ?? 0;

		// Gate 2, verbatim from the artifact: 400+ tokens saved OR at least 20% cut.
		const saved = tokensBefore - tokensAfter;
		const accepted = saved >= ABSOLUTE_SAVING_TOKENS || tokensAfter < RELATIVE_SAVING_RATIO * tokensBefore;
		if (rewrites.length === 0 || !accepted) return drafts;

		stats.events += 1;
		stats.tokensSaved += saved;
		drafts.push(...rewrites);
		drafts.push(bookkeeping({
			step: s - config.a,
			targetIds: rewrites.map((rewrite) => rewrite.targetId),
			tokensBefore,
			tokensAfter,
			track: "reflection",
			model: config.reflectorModel,
			usage: reflection.usage,
		}));

		return drafts;
	}

	/**
	 * Reflector spend never reaches Pi's session totals — ReadonlySessionManager has no
	 * appendUsage and only the compaction draft carries a usage field. Recording it here
	 * is what keeps an A/B honest.
	 */
	function bookkeeping(record: DietRecord): CustomEntryDraft {
		return { type: "custom", customType: "agentdiet", data: record };
	}

	async function reflect(
		ctx: ExtensionContext,
		steps: Step[],
		s: number,
		targets: StepTool[],
	): Promise<{ compressed: Map<string, string>; usage?: Usage } | undefined> {
		const [provider, ...rest] = config.reflectorModel.split("/");
		const model = ctx.modelRegistry.find(provider, rest.join("/"));
		if (!model) {
			if (ctx.hasUI) ctx.ui.notify(`agentdiet: reflector model ${config.reflectorModel} not found`, "warning");
			return undefined;
		}

		const targetIndex = s - config.a;
		const first = Math.max(0, targetIndex - config.b);
		// The artifact shows neighbours on both sides: range(idx - b, idx + a + 1).
		const rendered: string[] = [];
		for (let i = first; i <= s; i += 1) {
			rendered.push(renderStep(steps[i], i, i === targetIndex));
		}

		// No assistant prefill on the Responses API, so the artifact's priming line
		// becomes an explicit output-format instruction.
		const userPrompt = `${rendered.join("\n")}

Now, compress the step ${targetIndex}. Begin your output with <step id="${targetIndex}"> and end it with </step>.`;

		const signals = [AbortSignal.timeout(REFLECTOR_TIMEOUT_MS)];
		if (ctx.signal) signals.push(ctx.signal);

		const response = await ctx.modelRegistry.complete(
			model,
			{
				messages: [
					{ role: "system", content: SYS_PROMPT, timestamp: Date.now() },
					{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() },
				],
			},
			{
				maxTokens: REFLECTOR_MAX_TOKENS,
				signal: AbortSignal.any(signals),
				// Keeps the reflector off the agent's prompt_cache_key entirely.
				cacheRetention: "none",
				sessionId: uuidv7(),
			},
		);

		const raw = response.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		const compressed = parseCompressed(raw);
		if (compressed.size === 0) return undefined;

		// Only trust ids we actually asked about.
		const wanted = new Set(targets.map((tool) => tool.toolCallId));
		for (const id of [...compressed.keys()]) {
			if (!wanted.has(id)) compressed.delete(id);
		}

		return compressed.size > 0 ? { compressed, usage: response.usage } : undefined;
	}

	pi.registerCommand("diet", {
		description: "AgentDiet trajectory reduction: on | off | status | set <key> <value>",
		handler: async (args, ctx) => {
			const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);

			if (command === "on" || command === "off") {
				config = { ...config, enabled: command === "on" };
				saveConfig(config);
				const verdict = providerVerdict(ctx);
				const suffix = config.enabled && !verdict.ok ? ` (inactive: ${verdict.reason})` : "";
				ctx.ui.notify(`agentdiet: ${command}${suffix}`, "info");
				return;
			}

			if (command === "set") {
				const [key, rawValue] = rest;
				if (!key || rawValue === undefined) {
					ctx.ui.notify("Usage: /diet set <a|b|theta|model> <value>", "error");
					return;
				}
				if (key === "model") {
					config = { ...config, reflectorModel: rawValue };
				} else if (key === "a" || key === "b" || key === "theta") {
					const value = Number(rawValue);
					if (key === "a" && value < 1) {
						ctx.ui.notify("agentdiet: a=0 is the documented cliff (pass 65 -> 59). Refusing.", "error");
						return;
					}
					const limits = { a: [1, 5], b: [0, 3], theta: [100, 20_000] } as const;
					config = { ...config, [key]: clamp(value, limits[key][0], limits[key][1]) };
				} else {
					ctx.ui.notify(`Unknown key: ${key}`, "error");
					return;
				}
				saveConfig(config);
				ctx.ui.notify(`agentdiet: ${key} = ${key === "model" ? config.reflectorModel : config[key]}`, "info");
				return;
			}

			const verdict = providerVerdict(ctx);
			const usage = ctx.getContextUsage();
			ctx.ui.notify(
				[
					`agentdiet ${config.enabled ? "on" : "off"}${verdict.ok ? "" : ` (inactive: ${verdict.reason})`}`,
					`lag a=${config.a}  width b=${config.b}  theta=${config.theta} tokens`,
					`reflector: ${config.reflectorModel}`,
					`steps seen: ${stats.steps}  diet events: ${stats.events}  tokens saved: ${stats.tokensSaved}`,
					`reflector calls: ${stats.reflectorCalls}  reflector cost: $${stats.reflectorCost.toFixed(4)} (NOT in /session totals)`,
					usage?.tokens != null ? `context now: ${usage.tokens} / ${usage.contextWindow}` : "context now: unknown",
				].join("\n"),
				"info",
			);
		},
	});
}
