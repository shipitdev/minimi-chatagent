"""Graders.

Two principles:

1. **Deterministic where possible.** Substring checks and computed ground truth
   can't drift, don't cost anything, and can't be gamed. Recall and lookup items
   use these.
2. **Judged only where necessary, and always with a per-criterion breakdown.**
   Research items get a rubric judge, and the judge returns which *specific*
   criteria passed, so a score of 3/6 is inspectable rather than a vibe. The
   judge is a different prompt from any agent prompt and never sees the agent's
   traces — only the question and the answer.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from src.agent.agent import parse_json
from src.eval.datasets import Item


@dataclass
class Grade:
    item_id: str
    passed: bool
    score: float
    detail: str = ""
    criteria: dict[str, bool] = field(default_factory=dict)
    grader: str = ""
    meta: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "item_id": self.item_id,
            "passed": self.passed,
            "score": round(self.score, 3),
            "grader": self.grader,
            "detail": self.detail,
            "criteria": self.criteria,
            "meta": self.meta,
        }


def _norm(text: str) -> str:
    return re.sub(r"[\s\u00a0]+", " ", (text or "").lower())


# ---------------------------------------------------------------------------
# Deterministic graders
# ---------------------------------------------------------------------------


def _groups(item: Item) -> list[list[str]]:
    """Normalise `must_contain` into requirement groups.

    Each entry is one requirement; an entry that is itself a list supplies
    acceptable alternative spellings of the *same* requirement (e.g. "12,000" or
    "12000", "58.44" or "58.4"). Grading a flat list as a conjunction silently
    requires every spelling to appear, which is how the first harness run
    mis-scored a correct answer.
    """
    out: list[list[str]] = []
    for entry in item.must_contain:
        if isinstance(entry, (list, tuple)):
            alts = [str(a) for a in entry if str(a).strip()]
            if alts:
                out.append(alts)
        elif str(entry).strip():
            out.append([str(entry)])
    return out


def grade_contains(item: Item, answer: str) -> Grade:
    a = _norm(answer)
    groups = _groups(item)
    met = {i: any(_norm(alt) in a for alt in group) for i, group in enumerate(groups)}
    missing = [groups[i][0] for i, ok in met.items() if not ok]
    banned = [m for m in item.must_not_contain if _norm(m) in a]
    hits = len(groups) - len(missing)
    score = hits / max(1, len(groups))
    return Grade(
        item_id=item.id,
        passed=hits == len(groups) and not banned and bool(groups),
        score=score,
        grader="contains",
        detail=f"met {hits}/{len(groups)} requirements; missing {missing}; banned {banned}",
        criteria={groups[i][0]: ok for i, ok in met.items()},
    )


# Phrases that constitute an admission of a gap. This list has to include the
# agent's own honest-failure wording ("found nothing usable", "will not guess") or
# the grader will mark a correct refusal as a failure — which is what happened on
# the first run of the harness drill.
_REFUSAL_CUES = [
    "i don't know", "i do not know", "i couldn't find", "i could not find",
    "i can't find", "i cannot find", "not able to find", "unable to find",
    "no information", "couldn't locate", "could not locate", "no results",
    "i don't have", "i do not have", "cannot answer", "can't answer",
    "not possible to answer", "no reliable", "i'm not sure", "i am not sure",
    "does not appear", "doesn't appear", "couldn't verify", "could not verify",
    "not publicly available", "fictional", "did not find", "didn't find",
    "i have no", "no evidence",
    # agent's own honest-failure phrasings
    "nothing usable", "not about your question", "will not guess", "won't guess",
    "have no reliable answer", "no usable", "cannot verify", "can't verify",
    "does not exist", "doesn't exist", "not something i can", "no way to know",
]


def grade_refuses(item: Item, answer: str) -> Grade:
    """Pass only if the answer admits the gap and does not invent specifics."""
    a = _norm(answer)
    cues = [c for c in _REFUSAL_CUES if c in a]
    # A large number can legitimately appear in a refusal (e.g. "nothing usable
    # from 1,200 results"), so only treat it as an assertion when the answer is
    # *not* admitting a gap at all.
    has_figure = bool(re.search(r"\b\d{3,}\b", a))
    asserts_figure = has_figure and not cues
    # Hedge-then-invent patterns: a hedge plus a confident specific figure.
    invents = any(p in a for p in ("approximately", "around", "estimated at", "roughly")) and has_figure
    passed = bool(cues) and not invents
    return Grade(
        item_id=item.id,
        passed=passed,
        score=1.0 if passed else 0.0,
        grader="refuses",
        detail=f"cues={cues[:3]} invents={invents} asserts_figure={asserts_figure}",
        criteria={"admitted_gap": bool(cues), "did_not_invent": not invents},
    )


def grade_recall(item: Item, answer: str) -> Grade:
    """Recall is graded on the planted entities, and separately flags leakage of
    information that was never given (the failure mode that matters)."""
    a = _norm(answer)
    hits = [p for p in item.planted if _norm(p) in a]
    groups = _groups(item)
    met = {i: any(_norm(alt) in a for alt in group) for i, group in enumerate(groups)}
    matched = [groups[i][0] for i, ok in met.items() if ok]
    require_all = item.notes != "any"       # default: every requirement must be met
    if require_all:
        passed = all(met.values()) and bool(groups)
        score = sum(1 for v in met.values() if v) / max(1, len(groups))
    else:
        passed = any(met.values())
        score = 1.0 if passed else 0.0
    return Grade(
        item_id=item.id,
        passed=passed,
        score=score,
        grader="recall",
        detail=f"requirements_met={matched} planted_found={len(hits)}/{len(item.planted)}",
        criteria={groups[i][0]: ok for i, ok in met.items()},
        meta={"planted_recall": len(hits) / max(1, len(item.planted))},
    )


# ---------------------------------------------------------------------------
# Rubric judge
# ---------------------------------------------------------------------------

JUDGE_SYSTEM = """\
You are a strict, literal evaluator of answers. You are given a question, a list \
of criteria, and a candidate answer. For each criterion decide only whether the \
candidate answer actually satisfies it.

Rules:
- Judge the answer as written. Do not give credit for something you think the \
model probably knows but did not say.
- Do not reward verbosity, confidence or formatting. A long answer that misses a \
criterion fails that criterion.
- A criterion about citing a source is satisfied only if the answer contains a \
URL or an explicit document/paper identifier.
- If the answer contradicts an established fact, the relevant criterion fails.
- Partial satisfaction does not count as satisfaction.
"""

JUDGE_SCHEMA = """\
Reply with JSON only, exactly these keys:
{
  "criteria": [ { "criterion": "the criterion text, verbatim", "met": true|false, "why": "at most 12 words" } ],
  "factual_error": true | false,
  "notes": "at most 25 words"
}"""


def grade_judge(item: Item, answer: str, client, model_settings) -> Grade:
    criteria_block = "\n".join(f"{i+1}. {c}" for i, c in enumerate(item.rubric))
    prompt = f"""{JUDGE_SCHEMA}

QUESTION:
{item.prompt}

CRITERIA:
{criteria_block}

CANDIDATE ANSWER:
{answer[:4000]}
"""
    try:
        res = client.chat(
            [{"role": "system", "content": JUDGE_SYSTEM},
             {"role": "user", "content": prompt}],
            stage="judge",
            temperature=0.0,
            max_tokens=800,
            thinking=False,
            response_format={"type": "json_object"},
        )
        data = parse_json(res.content) or {}
    except Exception as e:
        return Grade(
            item_id=item.id, passed=False, score=0.0, grader="judge",
            detail=f"judge failed: {type(e).__name__}: {e}",
        )

    rows = data.get("criteria") or []
    met_by_text: dict[str, bool] = {}
    for r in rows:
        if isinstance(r, dict) and r.get("criterion"):
            met_by_text[_norm(str(r["criterion"]))] = bool(r.get("met"))

    criteria: dict[str, bool] = {}
    for c in item.rubric:
        if _norm(c) in met_by_text:
            criteria[c] = met_by_text[_norm(c)]
        else:
            # Judge paraphrased or dropped the criterion: match by token overlap.
            best, best_ov = False, 0.0
            ct = set(_norm(c).split())
            for k, v in met_by_text.items():
                kt = set(k.split())
                ov = len(ct & kt) / max(1, len(ct | kt))
                if ov > best_ov:
                    best_ov, best = ov, v
            criteria[c] = best if best_ov >= 0.5 else False

    n_met = sum(1 for v in criteria.values() if v)
    score = n_met / max(1, len(item.rubric))
    factual_error = bool(data.get("factual_error"))
    return Grade(
        item_id=item.id,
        passed=score >= 0.75 and not factual_error,
        score=score,
        grader="judge",
        detail=f"{n_met}/{len(item.rubric)} criteria; factual_error={factual_error}; "
               f"{data.get('notes','')}",
        criteria=criteria,
    )


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


def grade(item: Item, answer: str, client=None, settings=None) -> Grade:
    if item.grader == "contains":
        return grade_contains(item, answer)
    if item.grader == "recall":
        return grade_recall(item, answer)
    if item.grader == "refuses":
        return grade_refuses(item, answer)
    if item.grader == "judge":
        if client is None:
            return Grade(item_id=item.id, passed=False, score=0.0, grader="judge",
                         detail="judge skipped: no client")
        return grade_judge(item, answer, client, settings)
    if item.grader == "exact":
        ok = _norm(item.must_contain[0]) == _norm(answer) if item.must_contain else False
        return Grade(item_id=item.id, passed=ok, score=float(ok), grader="exact")
    return Grade(item_id=item.id, passed=False, score=0.0,
                 detail=f"unknown grader {item.grader}")
