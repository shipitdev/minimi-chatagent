"""Prompt architecture.

Design rules (derived from the research briefs in docs/):

1. **The system message is byte-identical for the lifetime of the agent.** It is
   the only prefix that is always cache-hit-able, so the tool schema, the
   output contract and the long-lived user profile all live there. Nothing
   turn-specific is ever allowed into it.
2. **One decision per call.** A small model's reliability collapses when asked
   to both decide and answer in one shot, so each stage has exactly one job and
   one output shape.
3. **No free-form reasoning fields we do not use.** Asking for a `reasoning`
   string before a decision is the cheapest known accuracy win for small models
   (it is a scratchpad), but it must be short and it must be discarded
   afterwards, never fed back — otherwise it becomes cache-hostile noise.
4. **Reflexion is bounded to exactly one retry**, and only for retrieval gaps.
   Unbounded self-critique is documented to make weak models *worse*.
5. **Evidence is a `system` message, not a fake tool result.** Chat Completions
   forbids client-inserted mid-conversation tool calls, and system messages are
   explicitly supported mid-conversation.
"""

from __future__ import annotations

from .config import Settings

# Explicit section delimiters.
#
# These exist so that any consumer of a prompt — a mock backend, a trace viewer, a
# test — can extract a section by marker rather than by relying on the incidental
# wording of the surrounding instructions. Discovering a section by prose is
# fragile: a reworded sentence silently changes what gets extracted, and the
# failure is invisible because the extraction still returns *something*.
MARK = "<<<{name}>>>"


def section(text: str, name: str) -> str:
    """Extract a delimited section. Returns "" when the marker is absent."""
    open_marker, close_marker = MARK.format(name=name), MARK.format(name=f"/{name}")
    start = text.find(open_marker)
    if start < 0:
        return ""
    start += len(open_marker)
    end = text.find(close_marker, start)
    return (text[start:end] if end >= 0 else text[start:]).strip()


def marked(name: str, body: str) -> str:
    return f"{MARK.format(name=name)}\n{body.strip()}\n{MARK.format(name=f'/{name}')}"

# ---------------------------------------------------------------------------
# 1. The invariant system prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """\
You are minimi, a careful research assistant. You answer the user's question \
using your own knowledge and, when needed, one tool: web_search.

## Tools
You have exactly one tool: `web_search`. Use it when the answer depends on \
facts you may not know, things that change over time, or sources the user asked \
for. Do not use it for arithmetic, definitions you are certain of, rewriting \
text the user supplied, or questions about this conversation.

## Grounding rules
1. Never invent a fact, number, date, name, URL or quotation.
2. Every factual sentence taken from the web must end with a citation like [1].
3. Cite only sources that appear in the EVIDENCE blocks you were given.
4. If the evidence does not contain the answer, say plainly what is missing. \
Do not fill the gap with plausible-sounding text.
5. If sources disagree, say so and prefer the one with higher authority.
6. Distinguish what a source states from what you infer. Mark inference with \
"Inference:".
7. Prefer the most recent source when the question is about something that \
changes over time, and state the source's date when you use it.

## Answer style
- Lead with the direct answer in the first sentence. No preamble.
- Match length to the question: one line for a factual lookup, a short \
structured answer for anything complex.
- Use short paragraphs or bullets. Use a markdown heading only for answers with \
three or more distinct sections.
- Answer in the language the user wrote in, unless they ask otherwise.
- End with a "Sources" list of the cited URLs, numbered to match the citations.

## Output contract
When you answer, you reply with the answer text only. You never *describe* \
calling a tool in prose; you either call it or you do not.
"""


# ---------------------------------------------------------------------------
# 2. Router / gate
#
# This is deliberately a NARROW ENUM, not a self-assessment. Asking a small model
# whether it "knows" something is the measured failure mode: Mallen 2212.10511
# finds adaptive-retrieval gains are "much smaller... models smaller than 10
# billion"; Adaptive-RAG 2403.14403 measures LLM-judged routing at 23.1 F1
# against 38.3 for a trained T5-Large classifier; SKR 2310.05002 finds direct
# self-knowledge prompting "relatively poor". So the gate classifies the SHAPE of
# the request, which is a much easier and more reliable judgement than the state
# of the model's own knowledge.
# ---------------------------------------------------------------------------

ROUTE_SCHEMA_HINT = """\
Reply with JSON only, exactly these keys:
{
  "route": "recall" | "direct" | "research",
  "query": "string"
}"""

ROUTE_INSTRUCTIONS = """\
Classify the newest user message into exactly one route.

"recall" — the message asks about this conversation or about the user
themselves. Signals: "what did I say", "remind me", "you told me", "my name",
"earlier", "summarise our chat", "what was my project called". Set query to the
words you would use to look this up in the transcript.

"direct" — the message is fully self-contained: arithmetic, logic, counting,
rewriting, translating, brainstorming, code the user pasted, an opinion, a
greeting. Nothing outside the conversation is needed, and a wrong answer would
not be a factual error about the world. Set query to "".

"research" — the message asks about the world: facts, people, products, papers,
dates, prices, laws, versions, news, comparisons the user expects to be sourced,
or anything using "latest", "current", "who won", "how much". Set query to a
short search query that would find the answer.

Decide on the SHAPE of the request, not on whether you think you know the
answer. You are not asked whether you are confident; a question about the world
is "research" even when you believe you know the answer, because the user is
entitled to a source. When it is genuinely between "direct" and "research",
choose "research": one cheap search is a far smaller error than an unsourced
claim.

Do not explain. JSON only.
"""


def route_prompt(question: str, memory_block: str, today: str | None = None) -> str:
    dated = (
        f"\nTODAY'S DATE: {today}. Use it to decide whether a question needs recent data.\n"
        if today else ""
    )
    return f"""{ROUTE_INSTRUCTIONS}

{ROUTE_SCHEMA_HINT}
{dated}
CONVERSATION MEMORY:
{memory_block}

{marked("MESSAGE", question)}
"""


# ---------------------------------------------------------------------------
# 3. Planner  (ReWOO-style: all queries decided before any search happens)
# ---------------------------------------------------------------------------

PLAN_SCHEMA_HINT = """\
Reply with JSON only, exactly these keys:
{
  "search_queries": [ { "query": "string", "why": "at most 10 words" } ],
  "answer_checklist": [ "string" ],
  "needs_recency": true | false,
  "language": "ISO-639-1 code of the answer language"
}"""

PLAN_INSTRUCTIONS = """\
Plan the search for the question below. You do not receive results yet; decide \
what to look for up front. This is deliberate: it stops you from re-searching \
for the same thing twice.

Rules for search_queries:
- Write 1 to 3 queries. Write 1 for a simple factual question. Write 2 or 3 only \
when the question genuinely has distinct parts that one query cannot cover.
- Each query is a literal search-engine query, 3 to 12 words. No sentences, no \
question marks, no "please find".
- Queries must be independent: do not write two queries that would return the \
same pages. Cover different facets, synonyms, or entities.
- Put the most essential query first.
- Use operators only when they clearly help: `site:` to confine to a known \
domain, `"quoted phrase"` for an exact string, `after:2025` for recency.
- Do not include the user's whole question verbatim if it is long. Extract the \
searchable core.

answer_checklist: 1 to 4 short items naming what the final answer must contain \
to fully answer the question. This is used to check for gaps later.

needs_recency: true if an outdated answer would be wrong.
"""


def plan_prompt(question: str, memory_block: str, route: str) -> str:
    return f"""{PLAN_INSTRUCTIONS}

{PLAN_SCHEMA_HINT}

GATE DECISION: {route} (a question about the world needing sourced facts)

CONVERSATION MEMORY:
{memory_block}

{marked("QUESTION", question)}
"""


# ---------------------------------------------------------------------------
# 4. Corrective re-query
#
# NOTE the inversion from the obvious design. The *decision* to search again is
# made by a deterministic harness counter (see agent.HarnessState), not by the
# model judging its own evidence. Intrinsic self-assessment is the measured
# small-model failure (2310.01798: models "struggle to self-correct... without
# external feedback, and at times their performance might even degrade"; SKR:
# direct prompting "relatively poor"). The model is used only for the part it is
# good at: writing one query for a gap that the harness has already identified.
# ---------------------------------------------------------------------------

GAP_SCHEMA_HINT = """\
Reply with JSON only, exactly these keys:
{
  "followup_query": "one search query string",
  "why": "at most 12 words"
}"""


def gap_prompt(
    question: str,
    checklist: list[str],
    uncovered: list[str],
    evidence_digest: str,
    used_queries: list[str],
) -> str:
    checks = "\n".join(f"- {c}" for c in checklist) or "- answer the question"
    missing = "\n".join(f"- {c}" for c in uncovered) or "- (unspecified)"
    used = "\n".join(f"- {q}" for q in used_queries) or "- (none)"
    return f"""Write ONE search query for a specific gap in evidence that has \
already been detected.

The gap is given to you; do not re-evaluate it and do not comment on it.

Rules:
- The query must target exactly the missing item below.
- It must be different from the queries already used; a repeat wastes a search.
- 3 to 12 words, as a search engine expects. No sentences, no question marks.
- Prefer distinctive nouns, names, numbers or versions over general words.

{GAP_SCHEMA_HINT}

{marked("QUESTION", question)}

WHAT THE ANSWER MUST COVER:
{checks}

DETECTED AS UNCOVERED:
{missing}

QUERIES ALREADY USED (do not repeat):
{used}

CURRENT EVIDENCE (for wording only — the gap is already known):
{evidence_digest}
"""


# ---------------------------------------------------------------------------
# 5. Synthesis
# ---------------------------------------------------------------------------

ANSWER_INSTRUCTIONS = """\
Answer the question using the evidence below.

Before you write, check each of these:
1. Does the first sentence directly answer the question? Rewrite it if not.
2. Does every factual claim have a [n] citation pointing at an EVIDENCE item?
3. Is anything stated that the evidence does not support? Remove it.
4. Are there numbers, dates or names taken from the evidence that must match \
exactly? Copy them character for character.
5. If the evidence conflicts with your own prior belief, trust the evidence.

Then write the answer. Do not mention the evidence blocks, the search process, \
or that you used a tool. Just answer.

If the evidence is insufficient, say exactly which part is unanswerable and \
answer the parts that are supported. Never pad.
"""


def answer_prompt(
    question: str,
    evidence_block: str,
    checklist: list[str],
    *,
    notes: str = "",
) -> str:
    checks = "\n".join(f"- {c}" for c in checklist) if checklist else "- (none)"
    extra = f"\nNOTES ON EVIDENCE QUALITY:\n{notes}\n" if notes else ""
    return f"""{ANSWER_INSTRUCTIONS}

WHAT THE ANSWER MUST COVER:
{checks}
{extra}
EVIDENCE:

{evidence_block}

{marked("QUESTION", question)}
"""


RECALL_INSTRUCTIONS = """\
Answer the user's question about your earlier conversation.

The transcript extracts below are the only source of truth. They are quoted \
verbatim from earlier turns.

Rules:
1. Quote the user's own words when you report what they said. Do not paraphrase \
a name, number, spelling or identifier - copy it exactly as it appears.
2. If the answer is not in the extracts, say you do not have it in this \
conversation. Do not guess and do not offer a plausible substitute.
3. If only part of the question is covered, answer that part and say plainly \
which part is not in the transcript.
4. Never claim the user said something the extracts do not contain.
5. Keep it short. The user is asking about their own information, not asking for \
an essay.
"""


def recall_prompt(question: str, retrieved: list[str], rolling_summary: str) -> str:
    if retrieved:
        body = "\n\n".join(f"--- extract {i} ---\n{t}" for i, t in enumerate(retrieved, 1))
    else:
        body = "(no matching earlier turns were found)"
    summary = rolling_summary.strip() or "(none)"
    return f"""{RECALL_INSTRUCTIONS}

QUESTION:
{question}

TRANSCRIPT EXTRACTS:
{body}

EARLIER CONVERSATION SUMMARY (context only; the extracts above take precedence):
{summary}
"""


def direct_answer_prompt(question: str, memory_block: str, task_type: str) -> str:
    return f"""Answer the newest user message directly. You have decided no \
search is needed.

Hard rules:
- This is a self-contained task: arithmetic, logic, rewriting, translation, \
code, or brainstorming. Work it out yourself and show the result.
- Do not hedge, do not add caveats about needing to verify, and do not mention \
searching or sources.
- Show the working or the result compactly. Match length to the question.
- Answer in the language the user wrote in.

TASK TYPE: {task_type}

CONVERSATION MEMORY:
{memory_block}

{marked("MESSAGE", question)}
"""


# ---------------------------------------------------------------------------
# 6. Compaction  (LLM-summarisation compaction, triggered by the budget)
# ---------------------------------------------------------------------------

SUMMARY_INSTRUCTIONS = """\
Compress the conversation excerpt below into a durable memory record. This \
record replaces the excerpt permanently, so anything you drop is lost forever.

Keep, in this priority order:
1. Every fact the user stated about themselves: names, roles, projects, dates, \
locations, preferences, constraints, identifiers.
2. Every decision, answer or recommendation that was given, and the reason.
3. Open threads: what the user asked for that was not finished, and what was \
promised next.
4. Entities and their relationships (which paper, which company, which version).
5. Corrections the user made, and anything the user said was wrong.

Drop: greetings, pleasantries, restatements of the question, search process \
narration, URLs of pages that were not the basis of an answer, and your own \
reasoning.

Write plain prose in the third person ("The user ..."). No headings, no bullets, \
no markdown. Be dense and specific. Copy names, numbers and dates exactly; never \
paraphrase an identifier. Do not add anything that is not in the excerpt.

Target length: {target_words} words or fewer.
"""


def summary_prompt(excerpt: str, existing_summary: str, target_words: int) -> str:
    prior = existing_summary.strip() or "(none yet)"
    return f"""{SUMMARY_INSTRUCTIONS.format(target_words=target_words)}

EXISTING MEMORY RECORD (merge the excerpt into this; keep it coherent):
{prior}

EXCERPT TO COMPRESS:
{excerpt}

Write the merged memory record now.
"""


# ---------------------------------------------------------------------------
# 7. File/entity extraction for the memory index
# ---------------------------------------------------------------------------

INDEX_SCHEMA_HINT = """\
Reply with JSON only, exactly these keys:
{
  "entities": [ "string" ],
  "topics": [ "string" ],
  "is_user_fact": true | false,
  "durable_fact": "one sentence, or empty string"
}"""

INDEX_INSTRUCTIONS = """\
Extract retrieval keys from this exchange so it can be found later.

- entities: proper nouns, product names, versions, file names, identifiers, \
numbers that matter. At most 6.
- topics: 1 to 4 lowercase topic labels.
- is_user_fact: true if the user revealed something durable about themselves.
- durable_fact: if is_user_fact, one sentence "The user ..." stating it. \
Otherwise "".
Copy identifiers exactly as written. Do not normalise or guess.
"""


def index_prompt(user_msg: str, assistant_msg: str) -> str:
    return f"""{INDEX_INSTRUCTIONS}

{INDEX_SCHEMA_HINT}

USER:
{user_msg[:1200]}

ASSISTANT:
{assistant_msg[:1200]}
"""


# ---------------------------------------------------------------------------
# 8. Memory-recall helper (answers recall questions from the episodic index)
# ---------------------------------------------------------------------------

def memory_block(
    rolling_summary: str,
    recalled: list[str],
    recent_exchanges: list[tuple[str, str]],
    *,
    max_exchanges: int = 4,
) -> str:
    """Assemble the memory section that goes into prompts.

    Ordering matters: the durable summary and recalled items come first (they are
    stable across turns, so they sit in the cacheable region), and the most recent
    exchanges come last, closest to the current question, because attention
    favours the end of the prompt.
    """
    parts: list[str] = []
    if rolling_summary.strip():
        parts.append(f"[DURABLE SUMMARY]\n{rolling_summary.strip()}")
    if recalled:
        joined = "\n".join(f"- {r}" for r in recalled)
        parts.append(f"[RECALLED EXCHANGES]\n{joined}")
    if recent_exchanges:
        tail = recent_exchanges[-max_exchanges:]
        rendered = []
        for q, a in tail:
            a_short = a if len(a) <= 700 else a[:700] + " ..."
            rendered.append(f"User: {q}\nYou: {a_short}")
        parts.append("[RECENT EXCHANGES]\n" + "\n\n".join(rendered))
    if not parts:
        return "(This is the first message in the conversation.)"
    return "\n\n".join(parts)


def build_settings_preface(settings: Settings) -> dict:
    """Token budget summary, useful in traces."""
    return {
        "model": settings.model,
        "context_budget_tokens": settings.context_budget_tokens,
        "keep_recent_turns": settings.keep_recent_turns,
        "max_search_rounds": settings.max_search_rounds,
    }
