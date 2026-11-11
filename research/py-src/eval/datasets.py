"""Evaluation datasets.

Design goals, in priority order:
1. **Cover the three user-visible prompt classes** the architecture claims to
   generalize over: fact lookup, research, and recall of past conversation.
2. **Include the cases where the right behaviour is to do nothing**: no-search
   reasoning, and unanswerable questions where the correct output is an honest
   admission rather than a fluent guess. A benchmark made only of answerable
   questions cannot measure the over-search and hallucination failure modes,
   which the research says are exactly where cheap models break.
3. **Be cheap to run**: small enough that a full pass is a few cents, so
   ablations are actually run rather than reasoned about.

Grading is per item type: exact/substring for lookups, a rubric judge for
research, computed ground truth for recall, and a boolean for refusal cases.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Item:
    id: str
    category: str
    prompt: str
    # grading
    grader: str                       # "contains" | "judge" | "recall" | "refuses" | "exact"
    # Each entry is ONE requirement. An entry may itself be a list of acceptable
    # alternative forms of that same requirement, e.g. ["58.44", "58.4", "58.5"].
    # A flat string entry is a single required form.
    must_contain: list = field(default_factory=list)
    must_not_contain: list[str] = field(default_factory=list)
    rubric: list[str] = field(default_factory=list)
    expected_search: bool | None = None   # for routing accuracy
    # multi-turn
    preamble: list[str] = field(default_factory=list)
    planted: list[str] = field(default_factory=list)
    notes: str = ""


# ---------------------------------------------------------------------------
# A. Reasoning / transformation — the correct behaviour is NO search.
#    These are chosen to be stable, self-contained, and unambiguous.
# ---------------------------------------------------------------------------

NO_SEARCH = [
    Item(
        id="r1", category="reasoning", grader="contains", expected_search=False,
        prompt="A train leaves at 14:20 and the journey takes 3 hours 45 minutes. "
               "What time does it arrive? Answer with the time only.",
        must_contain=[["18:05", "18.05", "6:05"]],
    ),
    Item(
        id="r2", category="reasoning", grader="contains", expected_search=False,
        prompt="Count the letter 'r' in the word 'strawberry'. Answer with the number only.",
        must_contain=[["3", "three"]],
    ),
    Item(
        id="r3", category="reasoning", grader="contains", expected_search=False,
        prompt="I have a 5-litre jug and a 3-litre jug and unlimited water. "
               "How do I measure exactly 4 litres? Give the steps briefly.",
        must_contain=["5", "3", "4"],
    ),
    Item(
        id="r4", category="reasoning", grader="contains", expected_search=False,
        prompt="Rewrite this sentence in the passive voice: 'The committee rejected the proposal.'",
        must_contain=["was rejected", "rejected by"],
    ),
    Item(
        id="r5", category="reasoning", grader="contains", expected_search=False,
        prompt="What is 17% of 340? Show the number.",
        must_contain=[["57.8", "57.80"]],
    ),
]


# ---------------------------------------------------------------------------
# B. Fact lookup — search required, one clear answer.
# ---------------------------------------------------------------------------

LOOKUP = [
    Item(
        id="l1", category="lookup", grader="contains", expected_search=True,
        prompt="Who wrote the paper that introduced the Transformer architecture, "
               "and what is the arXiv number of that paper?",
        must_contain=["attention is all you need", "1706.03762"],
    ),
    Item(
        id="l2", category="lookup", grader="contains", expected_search=True,
        prompt="What is the melting point of gallium in degrees Celsius?",
        must_contain=[["29.7", "29.76", "29.8", "30"]],
    ),
    Item(
        id="l3", category="lookup", grader="contains", expected_search=True,
        prompt="Which company develops the PyTorch deep learning framework, and which "
               "organisation originally created it?",
        must_contain=["meta", "facebook"],
    ),
    Item(
        id="l4", category="lookup", grader="contains", expected_search=True,
        prompt="What is the chemical formula for table salt, and what is its molar mass "
               "in grams per mole?",
        must_contain=["nacl", ["58.4", "58.44", "58.5", "58.43"]],
    ),
    Item(
        id="l5", category="lookup", grader="contains", expected_search=True,
        prompt="In what year was the country of Bangladesh founded, and who was its "
               "first president?",
        must_contain=["1971", ["mujibur", "mujib", "bangabandhu"]],
    ),
]


# ---------------------------------------------------------------------------
# C. Research / synthesis — multi-part, judged on a rubric.
# ---------------------------------------------------------------------------

RESEARCH = [
    Item(
        id="s1", category="research", grader="judge", expected_search=True,
        prompt="Compare LLMLingua and LLMLingua-2 for prompt compression. What does each "
               "one do, and what does each claim about speed or compression ratio?",
        rubric=[
            "Names LLMLingua and identifies it as perplexity/budget-controller based compression",
            "Names LLMLingua-2 and identifies it as token-classification based (a classifier, not a causal LM)",
            "States a concrete compression ratio claim (e.g. up to ~20x for LLMLingua)",
            "States a concrete speed claim for LLMLingua-2 (e.g. 3-6x faster compression)",
            "Cites at least one source with a URL or arXiv id",
            "Does not confuse the two methods",
        ],
    ),
    Item(
        id="s2", category="research", grader="judge", expected_search=True,
        prompt="What is the 'lost in the middle' problem in long-context language models, "
               "and what practical recommendation follows for where to place retrieved "
               "documents in a prompt?",
        rubric=[
            "Explains that model performance degrades for information in the middle of a long context",
            "Describes the U-shaped accuracy curve (better at the start and end)",
            "Gives the practical advice: put the most important retrieved documents at the beginning or end, not buried in the middle",
            "Mentions at least one source",
        ],
    ),
    Item(
        id="s3", category="research", grader="judge", expected_search=True,
        prompt="What are the main failure modes reported when compressing the context of an "
               "agent that is mid-task? Give concrete failure categories.",
        rubric=[
            "Identifies omission / losing information the agent later needed",
            "Identifies distortion or premature commitment to an interpretation",
            "Mentions repeated work as a consequence",
            "Mentions a source or benchmark",
        ],
    ),
    Item(
        id="s4", category="research", grader="judge", expected_search=True,
        prompt="Compare how the ReAct and ReWOO agent patterns structure a tool-using loop. "
               "What is the main efficiency difference and why?",
        rubric=[
            "ReAct interleaves reasoning and acting step by step",
            "ReWOO plans the whole chain of tool calls before executing",
            "Explains ReWOO's advantage: fewer redundant observations / less re-prompting of observations",
            "Mentions a source",
        ],
    ),
]


# ---------------------------------------------------------------------------
# D. Memory recall — planted in a preamble, queried several turns later.
#    Ground truth is computed, so grading is exact rather than judged.
# ---------------------------------------------------------------------------

RECALL = [
    Item(
        id="m1", category="recall", grader="recall", expected_search=False,
        preamble=[
            "My name is Priya Raman and I work at a company called Northwind Analytics.",
            "My main project is a document pipeline codenamed Halberd.",
        ],
        planted=["Priya Raman", "Northwind", "Halberd"],
        prompt="What is my name and what is my main project called?",
        must_contain=["Priya", "Halberd"],
    ),
    Item(
        id="m2", category="recall", grader="recall", expected_search=False,
        preamble=[
            "Please remember these details: the deployment region is eu-west-2 and the "
            "database engine is PostgreSQL 16.",
            "My team has four engineers: Alice, Ben, Chen and Dara.",
        ],
        planted=["eu-west-2", "PostgreSQL 16", "Alice", "Ben", "Chen", "Dara"],
        prompt="Which deployment region did I tell you to use, and which database engine?",
        must_contain=["eu-west-2", "postgres"],
    ),
    Item(
        id="m3", category="recall", grader="recall", expected_search=False,
        preamble=[
            "I'm allergic to peanuts and I'm lactose intolerant, in case that matters later.",
            "I usually work late on Tuesdays and Thursdays.",
        ],
        planted=["peanuts", "lactose"],
        prompt="What food restrictions did I mention?",
        must_contain=["peanut", "lactose"],
    ),
    Item(
        id="m4", category="recall", grader="recall", expected_search=False,
        preamble=[
            "The budget cap for this quarter is 12,000 dollars and we have not started "
            "spending yet.",
            "Our launch date slipped from March to June.",
        ],
        planted=["12,000", "June"],
        prompt="What is our budget cap, and when is the launch now planned?",
        must_contain=[["12,000", "12000", "12k"], "june"],
    ),
]


# ---------------------------------------------------------------------------
# E. Honest-failure cases: the model must not invent.
# ---------------------------------------------------------------------------

HONEST = [
    Item(
        id="h1", category="honest", grader="refuses", expected_search=True,
        prompt="What was the exact attendance figure at my cousin's wedding in "
               "Rourkela last November?",
        must_not_contain=[], notes="Private information that cannot be in the index.",
    ),
    Item(
        id="h2", category="honest", grader="refuses", expected_search=True,
        prompt="What did the CEO of Zynthex Dynamics announce in her keynote yesterday? "
               "Zynthex Dynamics is a fictional company that does not exist.",
        notes="Fictional entity: correct behaviour is to say it found nothing.",
    ),
]


ALL_ITEMS = NO_SEARCH + LOOKUP + RESEARCH + RECALL + HONEST


# ---------------------------------------------------------------------------
# Multi-turn scenario: exercises compaction and cross-turn coherence.
# ---------------------------------------------------------------------------

SCENARIO = [
    "Hi — for context, my name is Dev and I'm building a chat agent that uses exactly one "
    "tool: web search. The model is DeepSeek Flash.",
    "What do you know about the LLMLingua family of prompt compression methods?",
    "Which of those would you actually use in a production single-tool search agent, and why?",
    "Going back to what I told you at the start: what is the name of the model I said I'm using?",
    "Now summarise everything we've covered in three bullets.",
]
SCENARIO_EXPECT_LAST = ["llmlingua"]


# ---------------------------------------------------------------------------
# Ablation configurations
# ---------------------------------------------------------------------------

ABLATIONS = {
    "full":            dict(),
    "no_router":       dict(enable_router=False),
    "no_planning":     dict(enable_planning=False),
    "no_corrective":   dict(enable_corrective=False),
    "no_relevance":    dict(enable_relevance_gate=False),
    "no_pipeline":     dict(enable_router=False, enable_planning=False, enable_corrective=False),
    "small_budget":    dict(context_budget_tokens=3000),
}


def by_category(cat: str) -> list[Item]:
    return [i for i in ALL_ITEMS if i.category == cat]
