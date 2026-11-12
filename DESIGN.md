# MiniChat — a chat assistant with memory and web search

I built MiniChat to answer quickly, get the details right, and remember what you asked and when. I designed it around three places an answer can go wrong. The agent can recall the wrong conversation, take too long to check several sources, or lose a detail that changes the answer.

## How it works

The MiniChat harness builds on DeepSeek Harness for the agent loop, sessions, and streaming. I added dated memory, one custom `web_search` tool backed by DeepSeek Search and Fetch, and an evidence compressor that keeps relevant passages and their source links.

**Memory.** If you ask what we discussed last Monday, a similar conversation from the wrong day can look like a good match. I store conversations and shortlist snapshots in SQLite and apply the date window in the user’s timezone before ranking results. Keyword matching can still miss a conversation when you describe it differently. For change checks, MiniChat compares saved observations with current evidence and checks that details like the plan and billing terms line up.

**Web search.** Checking sources one at a time adds up, and snippets can leave out important details. I integrated DeepSeek Search and Fetch behind one tool so MiniChat can run independent lookups in parallel and open the original page when it needs more detail. The harness caps provider attempts, including retries. If one lookup fails, the results from the others are still available.

**Results.** Search results and fetched pages can flood the model with menus, repeated text, and irrelevant passages. I extract the passages that matter and keep their source links. On three recorded inputs, this cut the estimated token count of the full tool response by **30%, 60%, and 69%**. One eval kept a 100 GB quota and dropped when it resets. That’s the kind of detail I’d check at every compression budget.

## What I considered

My first implementation owned routing, planning, and answering. I chose an existing agent loop so I could focus on what MiniChat needs to control: which conversation it recalls, how much research it runs, and what evidence it gives the model. The resulting app passed **8/8 browser checks**, including search, citations, and recall after restart.

I chose dated records over a rolling summary because a change check needs the original date, source, and terms. I chose to extract passages in code because I can inspect what survived and avoid another model call.

## What I saw in the app

In manual walkthroughs of the challenge examples, MiniChat recovered all five Monday CRMs and found a price increase and a major release. It recovered the November 3 conversation and identified a price increase. For last Tuesday’s Postgres question, it resolved the date and identified the earlier provider.

## What I’d do with another week

I’d use MiniChat for my own research and give it to a few friends to try on theirs. I’d review the conversations, trace each bad answer back to where it went wrong, and turn those failures into regression tests that run through the actual app after each change.

I’d start with memory and tool context. I’d measure how often MiniChat finds the exact turn across similar conversations, corrections, and vague follow-ups. Then I’d replay the same search results at smaller evidence budgets and compare answer completeness, citation support, and latency.

**Run locally** with Node 24.9+, `npm install`, `.env` configured from `.env.example`, and `npm run dev`. See [Architecture](architecture.md) and [Decisions](decisions.md) for the details.
