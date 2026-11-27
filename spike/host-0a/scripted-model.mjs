#!/usr/bin/env node
/**
 * Spike 0a scripted model: an OpenAI-compatible /v1/chat/completions endpoint (streamed) that
 * plays both sides of one round trip without any provider credential.
 *
 * Parent (its first user message holds SPIKE-PARENT-GO): turn 1 calls `subagent` with a task that
 * holds SPIKE-CHILD-TASK; after the tool result it says it waits; once a later message carries the
 * child's token it answers SPIKE-PARENT-RECEIVED <token>.
 * Child (its first user message holds SPIKE-CHILD-TASK): answers the token and ends, so an
 * auto-exit child finishes.
 *
 * usage: node scripted-model.mjs <port> <log file>
 */
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [port = "4874", log = "/dev/stderr"] = process.argv.slice(2);
const TOKEN = "SPIKE-CHILD-RESULT-7f3a";

const text = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p?.text ?? "").join("") : "");

function decide(messages) {
  const users = messages.filter((m) => m.role === "user");
  const first = text(users[0]?.content);
  const last = messages[messages.length - 1];
  if (first.includes("SPIKE-CHILD-TASK")) return { who: "child", say: `${TOKEN}` };
  if (!first.includes("SPIKE-PARENT-GO")) return { who: "other", say: "SPIKE-OTHER" };
  const assistants = messages.filter((m) => m.role === "assistant");
  if (assistants.length === 0)
    return { who: "parent", call: { name: "subagent", arguments: JSON.stringify({ name: "spike-child", task: "SPIKE-CHILD-TASK: reply with your token and stop." }) } };
  const later = messages.slice(messages.indexOf(assistants[0]) + 1).filter((m) => m.role !== "assistant" && m.role !== "tool");
  if (later.some((m) => text(m.content).includes(TOKEN))) return { who: "parent", say: `SPIKE-PARENT-RECEIVED ${TOKEN}` };
  if (last?.role === "tool") return { who: "parent", say: "SPIKE-PARENT-WAITING" };
  return { who: "parent", say: "SPIKE-PARENT-IDLE" };
}

const chunk = (res, body) => res.write(`data: ${JSON.stringify({ id: "spike", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "scripted", ...body })}\n\n`);

createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw);
    const plan = decide(body.messages ?? []);
    const tools = (body.tools ?? []).map((t) => t.function?.name);
    appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), who: plan.who, messages: body.messages?.length, roles: body.messages?.map((m) => m.role).join(","), hasSubagent: tools.includes("subagent"), hasCallerPing: tools.includes("caller_ping"), reply: plan.call ? `call ${plan.call.name}` : plan.say })}\n`);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (plan.call) {
      chunk(res, { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: plan.call }] }, finish_reason: null }] });
      chunk(res, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      chunk(res, { choices: [{ index: 0, delta: { role: "assistant", content: plan.say }, finish_reason: null }] });
      chunk(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    chunk(res, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.end("data: [DONE]\n\n");
  });
}).listen(Number(port), "127.0.0.1");
