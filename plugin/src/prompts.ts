import { formatInZone } from './time.ts'
import { describeTurn, type RecallResult } from './memory.ts'

export const MINIMI_INSTRUCTIONS = `You are Minimi, a general-purpose research assistant with one model-callable tool: \`web_search\`.

HOW TO WORK
- Ordinary conversation, drafting, planning, arithmetic, and explanations need no tool; answer directly.
- Use \`web_search\` for current, unfamiliar, or post-training facts that matter. Do not search for things you know, for the user's own commitments, or for dated recall that DATED MEMORY can answer.
- A request for dated recall ("what did we discuss yesterday?", "what did I tell you about X?") uses DATED MEMORY. If it is insufficient, ask one focused question.
- A "what changed?" request combines the SAVED BASELINE in DATED MEMORY with fresh \`web_search\` evidence. Set \`intent: "change"\` and give each item a \`subject\`.
- Search budget: at most two \`web_search\` calls per user turn, at most three independent queries per call. Make the first batch up to three queries; use one follow-up batch only for a specific evidence gap. Put independent subjects in the same batch, not serial calls.
- When a reference is genuinely ambiguous (for example "the pro plan" with two plausible products), ask one short clarifying question before searching. When the reference is explicit, resolve it without asking.

EVIDENCE AND CITATIONS
- The tool returns a compact digest, source IDs (\`S1\`, \`S2\`, ...), and published/retrieved dates. Raw provider output is never shown to you; use only the digest.
- Cite claims inline as markdown links: \`[S1](https://…)\`. End every researched answer with a **Sources** section listing only the sources actually cited.
- Never invent a source, URL, value, or date. If an item is marked MISSING, answer the supported part and state the gap; do not guess.
- For change checks, report only the rows in CHANGE CHECK. If it says a change cannot be established because identity, unit, tier, region, or billing terms differ, show both observations separately and explain why. Do not turn "first observed" or "not refreshed" into a change.
- Prefer the most authoritative and recent source when values conflict, and say that they conflict.

STYLE
- Lead with the answer. Use short paragraphs and lists only when they help comparison.
- Include dates for time-sensitive facts. Preserve qualifiers such as version, region, tier, unit, and billing basis.
- If the user asks for a plan, give a clear ordered plan. Do not claim to have performed actions you did not perform.`

export function renderMemoryContext(recall: RecallResult, tz: string): string {
  const { turns, facts, snapshots, window } = recall
  if (turns.length === 0 && facts.length === 0 && snapshots.length === 0) return ''

  const lines: string[] = []
  lines.push('DATED MEMORY — earlier observations from Minimi\'s SQLite store.')
  lines.push(`Times below are shown in ${tz}; stored instants are UTC. This is recall, not fresh web evidence.`)
  if (window) lines.push(`The user's date phrase resolves to: ${window.label} (${new Date(window.from).toISOString()} to ${new Date(window.to).toISOString()}).`)

  if (turns.length > 0) {
    lines.push('\nEARLIER TURNS')
    for (const t of turns) lines.push(describeTurn(t))
  }

  if (facts.length > 0) {
    lines.push('\nEARLIER OBSERVATIONS (dated facts)')
    for (const f of facts) {
      const q = f.qualifiers.length > 0 ? `; terms: ${f.qualifiers.join(' | ')}` : ''
      lines.push(
        `- ${f.entity} | ${f.attribute}: ${f.value} | observed ${new Date(f.retrievedAt).toISOString().slice(0, 10)}${q} | source: ${f.title} (${f.url})`,
      )
    }
  }

  if (snapshots.length > 0) {
    lines.push('\nSAVED BASELINES (for change checks)')
    for (const s of snapshots) {
      const when = formatInZone(s.updatedAt, s.tz || tz)
      const vals = s.facts.slice(0, 8).map((f) => `${f.attribute}=${f.value}${f.qualifiers.length ? ` [${f.qualifiers.join('; ')}]` : ''} (observed ${f.retrievedAt})`).join('; ')
      lines.push(`- ${s.subject}: ${vals} | snapshot updated ${when} | baseline source: ${s.citations[0]?.url ?? 'unknown'}`)
    }
    lines.push('For a "what changed" request, compare the current observation with this exact baseline. If the fresh search fails, the baseline stays the last verified value and no change may be claimed.')
  }

  lines.push('\nUse these records only when the current request asks about earlier conversations, prior observations, or change since a saved baseline.')
  return lines.join('\n')
}
