import assert from "node:assert/strict";
import { collectSteps, supersededReads, parseCompressed } from "./index.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

// --- fixture builders -------------------------------------------------------
const entries = [];
const raw = new Map();
function assistant(id, toolCalls = []) {
  const message = { role: "assistant", content: [{ type: "text", text: "thinking" }, ...toolCalls] };
  const e = { sourceEntry: { id, type: "message", message }, messages: [message] };
  entries.push(e); raw.set(id, e.sourceEntry); return id;
}
function toolResult(id, toolCallId, toolName, text, isError = false) {
  const message = { role: "toolResult", toolCallId, toolName, isError, content: [{ type: "text", text }] };
  const e = { sourceEntry: { id, type: "message", message }, messages: [message] };
  entries.push(e); raw.set(id, e.sourceEntry); return id;
}
function user(id) {
  const message = { role: "user", content: [{ type: "text", text: "go" }] };
  const e = { sourceEntry: { id, type: "message", message }, messages: [message] };
  entries.push(e); raw.set(id, e.sourceEntry); return id;
}
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const ctx = { cwd: "/repo", sessionManager: { getEntry: (id) => raw.get(id) } };

// --- the session ------------------------------------------------------------
user("u1");
assistant("a0", [call("tc1", "read", { path: "spec.md" })]);
toolResult("r0", "tc1", "read", "X".repeat(4000));
assistant("a1", [call("tc2", "bash", { cmd: "ls" })]);
toolResult("r1", "tc2", "bash", "Y".repeat(8000));
assistant("a2", [call("tc3", "read", { path: "spec.md", offset: 10, limit: 5 })]);
toolResult("r2", "tc3", "read", "partial");
assistant("a3", [call("tc4", "read", { path: "./spec.md" })]);   // full re-read, supersedes r0
toolResult("r3", "tc4", "read", "Z".repeat(4000));
assistant("a4", [call("tc5", "grep", { q: "x" })]);
toolResult("r4", "tc5", "grep", "hit", true);                     // isError
const steps = collectSteps(entries);

console.log("collectSteps");
check("one step per assistant message", () => assert.equal(steps.length, 5));
check("tool results attach to their assistant", () => {
  assert.deepEqual(steps.map((s) => s.tools.length), [1, 1, 1, 1, 1]);
  assert.equal(steps[0].assistantEntryId, "a0");
  assert.equal(steps[0].tools[0].entryId, "r0");
});
check("a user message closes the open step", () => {
  const extra = [...entries, { sourceEntry: { id: "u2", type: "message", message: { role: "user", content: [] } }, messages: [] },
                             { sourceEntry: { id: "rX", type: "message", message: { role: "toolResult", toolCallId: "z", toolName: "bash", isError: false, content: [] } }, messages: [] }];
  const s2 = collectSteps(extra);
  assert.equal(s2.length, 5, "orphan toolResult after a user message must not join step 4");
  assert.equal(s2[4].tools.length, 1);
});
check("step index does not reset across user prompts", () => {
  const two = [];
  const push = (e) => two.push(e);
  push({ sourceEntry: { id: "ua", type: "message", message: { role: "user", content: [] } }, messages: [] });
  push({ sourceEntry: { id: "aa", type: "message", message: { role: "assistant", content: [] } }, messages: [] });
  push({ sourceEntry: { id: "ub", type: "message", message: { role: "user", content: [] } }, messages: [] });
  push({ sourceEntry: { id: "ab", type: "message", message: { role: "assistant", content: [] } }, messages: [] });
  assert.equal(collectSteps(two).length, 2, "s must keep counting across a second user prompt");
});

console.log("supersededReads");
check("a later full read supersedes earlier reads of the same path", () => {
  const out = supersededReads(ctx, steps, 4);
  // r0 (full) and r2 (ranged) both precede r3, a later FULL read of the same file.
  // A full read contains everything a ranged read showed, so both are safe to replace.
  assert.deepEqual(out.map((r) => r.entryId), ["r0", "r2"]);
  assert.equal(out[0].path, "/repo/spec.md", "relative and ./-prefixed paths must resolve equal");
});
check("the newest full read is never touched", () => {
  assert.ok(!supersededReads(ctx, steps, 4).some((r) => r.entryId === "r3"));
});
check("a ranged read is never the superseder", () => {
  // entries[0..6] = u1, a0, r0, a1, r1, a2, r2 -> the only later read of spec.md is
  // r2, which is ranged. It must NOT supersede the earlier full read r0.
  const upToRanged = supersededReads(ctx, collectSteps(entries.slice(0, 7)), 9);
  assert.equal(upToRanged.length, 0, "a ranged read must never supersede anything");
});
check("offset:1 / limit:null counts as a whole-file read", () => {
  // Constrained JSON-schema sampling makes models emit every property, so the
  // common spelling of "read the whole file" is {offset: 1, limit: null}, not {}.
  const e = [];
  const r2 = new Map();
  const add = (id, message) => { const x = { sourceEntry: { id, type: "message", message }, messages: [message] }; e.push(x); r2.set(id, x.sourceEntry); };
  add("A0", { role: "assistant", content: [call("c1", "read", { path: "f.md", offset: 1, limit: null })] });
  add("R0", { role: "toolResult", toolCallId: "c1", toolName: "read", isError: false, content: [{ type: "text", text: "old" }] });
  add("A1", { role: "assistant", content: [call("c2", "bash", { command: "ls" })] });
  add("R1", { role: "toolResult", toolCallId: "c2", toolName: "bash", isError: false, content: [{ type: "text", text: "x" }] });
  add("A2", { role: "assistant", content: [call("c3", "read", { path: "f.md", offset: 1, limit: null })] });
  add("R2", { role: "toolResult", toolCallId: "c3", toolName: "read", isError: false, content: [{ type: "text", text: "new" }] });
  const out = supersededReads({ cwd: "/repo", sessionManager: { getEntry: (id) => r2.get(id) } }, collectSteps(e), 2);
  assert.deepEqual(out.map((r) => r.entryId), ["R0"]);
});
check("a real offset still blocks superseding", () => {
  const e = [];
  const r2 = new Map();
  const add = (id, message) => { const x = { sourceEntry: { id, type: "message", message }, messages: [message] }; e.push(x); r2.set(id, x.sourceEntry); };
  add("A0", { role: "assistant", content: [call("c1", "read", { path: "f.md", offset: 1, limit: null })] });
  add("R0", { role: "toolResult", toolCallId: "c1", toolName: "read", isError: false, content: [{ type: "text", text: "old" }] });
  add("A1", { role: "assistant", content: [call("c2", "read", { path: "f.md", offset: 40, limit: null })] });
  add("R1", { role: "toolResult", toolCallId: "c2", toolName: "read", isError: false, content: [{ type: "text", text: "tail" }] });
  const out = supersededReads({ cwd: "/repo", sessionManager: { getEntry: (id) => r2.get(id) } }, collectSteps(e), 2);
  assert.equal(out.length, 0, "a read starting at line 40 does not contain the head of the file");
});
check("the lag cutoff is honoured", () => {
  assert.equal(supersededReads(ctx, steps, -1).length, 0, "cutoff -1 must exclude every step");
});

console.log("parseCompressed");
check("extracts each result by id", () => {
  const m = parseCompressed('<step id="3">\n<result id="tc2" tool="bash">\nsmall\n</result>\n</step>trailing junk');
  assert.equal(m.size, 1);
  assert.equal(m.get("tc2"), "small");
});
check("stops at the first </step>", () => {
  const m = parseCompressed('<step id="3"><result id="a" tool="bash">keep</result></step><result id="b" tool="bash">drop</result>');
  assert.deepEqual([...m.keys()], ["a"]);
});
check("empty or malformed output yields nothing", () => {
  assert.equal(parseCompressed("").size, 0);
  assert.equal(parseCompressed("I cannot compress this.").size, 0);
});

console.log(`\n${pass} passed`);
