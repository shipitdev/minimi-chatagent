/**
 * Structured model calls: JSON mode + Zod validation + one repair attempt.
 *
 * A small model will occasionally return JSON that parses but has the wrong shape
 * (a string where an array belongs, a missing key). Silently coercing that is how
 * a malformed plan becomes a wrong answer three steps later. Instead every
 * structured call is validated, and a failure gets exactly one cheap repair round
 * before the caller is told it failed.
 */

import type { z } from "zod";
import { chat, type ChatMessage } from "./deepseek.js";
import { SYSTEM } from "./prompts.js";
import { emptyUsage, type Usage } from "./config.js";
import type { ChatResult } from "./deepseek.js";

export interface StructuredResult<T> {
  data: T;
  usage: Usage;
  /** True when the first response was invalid and had to be repaired. */
  repaired: boolean;
}

export class StructuredError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
  }
}

/** Pull the first JSON object out of a response that may be fenced or chatty. */
export function extractJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to a bracket scan.
  }
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function zodText<T>(
  prompt: string,
  opts: {
    schema: z.ZodType<T>;
    maxTokens?: number;
    temperature?: number;
    system?: string;
    /** Skip the SYSTEM prefix for calls that only need a transformation. */
    lean?: boolean;
    /** Trace label, e.g. "route" | "plan" | "claim_check". */
    stage?: string;
  },
): Promise<StructuredResult<T>> {
  const usage = emptyUsage();
  const system = opts.system ?? (opts.lean ? "Reply with JSON only. No prose, no markdown fences." : SYSTEM);
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];

  let res: ChatResult = await chat(messages, {
    json: true,
    temperature: opts.temperature ?? 0,
    maxTokens: opts.maxTokens ?? 800,
    stage: opts.stage ?? "structured",
  });
  usage.modelCalls += 1;
  usage.promptTokens += res.usage.promptTokens;
  usage.completionTokens += res.usage.completionTokens;
  usage.cacheHitTokens += res.usage.cacheHitTokens;
  usage.cacheMissTokens += res.usage.cacheMissTokens;

  const first = extractJson(res.content);
  const firstParsed = opts.schema.safeParse(first);
  if (firstParsed.success) {
    return { data: firstParsed.data, usage, repaired: false };
  }

  // One repair round. Include the validation error so the model has something
  // concrete to fix, which is far more effective than re-asking.
  const issues = firstParsed.error.issues
    .slice(0, 4)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  const repairPrompt = `${prompt}

Your previous reply was rejected by schema validation: ${issues}

Reply again with corrected JSON only.`;
  res = await chat(
    [
      { role: "system", content: system },
      { role: "user", content: repairPrompt },
    ],
    { json: true, temperature: 0, maxTokens: opts.maxTokens ?? 800, stage: `${opts.stage ?? "structured"}.repair` },
  );
  usage.modelCalls += 1;
  usage.promptTokens += res.usage.promptTokens;
  usage.completionTokens += res.usage.completionTokens;
  usage.cacheHitTokens += res.usage.cacheHitTokens;
  usage.cacheMissTokens += res.usage.cacheMissTokens;

  const second = extractJson(res.content);
  const secondParsed = opts.schema.safeParse(second);
  if (secondParsed.success) {
    return { data: secondParsed.data, usage, repaired: true };
  }
  throw new StructuredError(
    `model did not return valid structured output after repair: ${secondParsed.error.issues
      .slice(0, 3)
      .map((i) => i.message)
      .join("; ")}`,
    res.content,
  );
}

/** Prose call that returns text plus usage. */
export async function prose(
  prompt: string,
  opts: { maxTokens?: number; temperature?: number; system?: string; lean?: boolean; stage?: string } = {},
): Promise<{ text: string; usage: Usage }> {
  const res = await chat(
    [
      { role: "system", content: opts.system ?? (opts.lean ? "Reply with the requested text only." : SYSTEM) },
      { role: "user", content: prompt },
    ],
    {
      temperature: opts.temperature ?? 0.3,
      maxTokens: opts.maxTokens ?? 900,
      json: false,
      stage: opts.stage ?? "prose",
    },
  );
  const usage = emptyUsage();
  usage.modelCalls = 1;
  usage.promptTokens = res.usage.promptTokens;
  usage.completionTokens = res.usage.completionTokens;
  usage.cacheHitTokens = res.usage.cacheHitTokens;
  usage.cacheMissTokens = res.usage.cacheMissTokens;
  return { text: res.content.trim(), usage };
}
