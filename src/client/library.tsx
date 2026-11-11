/**
 * Client-side OpenUI library: real React renderers for the shared schemas.
 *
 * These components are the reason the product is a generative UI rather than a
 * chat transcript with tables bolted on. The model (or the deterministic composer)
 * emits OpenUI Lang describing *what to show*; these renderers decide *how*, and
 * they reuse one visual language across every view.
 *
 * Column-oriented props are zipped back into rows here, in one place, so a
 * length mismatch degrades gracefully (the shorter array wins) instead of
 * crashing the render.
 */

import React from "react";
import { z } from "zod";
import { createLibrary, defineComponent } from "@openuidev/react-lang";
import { componentSpecs, REPORT_DESCRIPTION, REPORT_NAME } from "../library/schema.js";

/**
 * Zip parallel columns into rows. Deliberately heterogeneous and length-safe:
 * `Math.min` means a mismatched array shortens the table instead of throwing,
 * because the alternative is a blank message for the user.
 */
function zip(...cols: Array<Array<unknown>>): Array<Array<unknown>> {
  if (cols.length === 0) return [];
  const n = Math.min(...cols.map((c) => c.length));
  const rows: Array<Array<unknown>> = [];
  for (let i = 0; i < n; i++) rows.push(cols.map((c) => c[i]));
  return rows;
}

/** Render a body with [n] markers as inline, clickable citation chips. */
function CitedBody({ body, urls }: { body: string; urls: string[] }) {
  const parts = body.split(/(\[\d{1,2}\])/g);
  return (
    <p className="answer-body">
      {parts.map((part, i) => {
        const m = /^\[(\d{1,2})\]$/.exec(part);
        if (!m) return <React.Fragment key={i}>{part}</React.Fragment>;
        const id = Number(m[1]);
        const url = urls[id - 1];
        return (
          <a
            key={i}
            className="cite-chip"
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            title={url ?? `source ${id}`}
          >
            {id}
          </a>
        );
      })}
    </p>
  );
}

const NoteView = ({ body }: { body: string }) => <p className="note">{body}</p>;

const AnswerCardView = ({
  body,
  citeTitles,
  citeDomains,
  citeUrls,
}: {
  body: string;
  citeTitles: string[];
  citeDomains: string[];
  citeUrls: string[];
}) => (
  <section className="card answer-card">
    <CitedBody body={body} urls={citeUrls} />
    {citeUrls.length > 0 && (
      <div className="sources">
        <span className="sources-label">Sources</span>
        <ol>
          {zip(citeTitles, citeDomains, citeUrls).map(([title, domain, url], i) => (
            <li key={i}>
              <a href={String(url)} target="_blank" rel="noreferrer noopener">
                {String(title || domain)}
              </a>
              <span className="domain">{String(domain)}</span>
            </li>
          ))}
        </ol>
      </div>
    )}
  </section>
);

// The Report container is built separately from the others, because its `blocks`
// prop is a union of their schemas.
const STATUS_CLASS: Record<string, string> = {
  updated: "st-updated",
  new: "st-new",
  unchanged: "st-unchanged",
  missing: "st-missing",
};

const ChangeListView = ({
  heading,
  labels,
  statuses,
  notes,
  froms,
  tos,
  sourceIds,
}: {
  heading: string;
  labels: string[];
  statuses: string[];
  notes: string[];
  froms: string[];
  tos: string[];
  sourceIds: string[];
}) => {
  const rows = zip(labels, statuses, notes, froms, tos, sourceIds) as string[][];
  return (
    <section className="card">
      <h3 className="card-title">{heading}</h3>
      <ul className="change-list">
        {rows.map(([label, status, note, from, to, src], i) => (
          <li key={i} className={`change-row ${STATUS_CLASS[status ?? ""] ?? ""}`}>
            <div className="change-head">
              <span className="change-label">{label}</span>
              <span className={`badge ${STATUS_CLASS[status ?? ""] ?? ""}`}>{status}</span>
            </div>
            {(from || to) && (
              <div className="change-values">
                {from && <span className="old">{from}</span>}
                {from && to && <span className="arrow">→</span>}
                {to && <span className="new">{to}</span>}
              </div>
            )}
            <div className="change-note">{note}</div>
            {src && (
              <div className="change-src">
                {src
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((s) => (
                    <span key={s} className="cite-chip">
                      {s}
                    </span>
                  ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};

const RecallTimelineView = ({
  heading,
  window,
  titles,
  whens,
  tzs,
  counts,
  snippets,
  ids,
}: {
  heading: string;
  window: string;
  titles: string[];
  whens: string[];
  tzs: string[];
  counts: number[];
  snippets: string[];
  ids: string[];
}) => {
  const rows = zip(titles, whens, tzs, counts, snippets, ids) as Array<[string, string, string, number, string, string]>;
  return (
    <section className="card">
      <h3 className="card-title">{heading}</h3>
      <div className="timeline-window">{window}</div>
      <ul className="timeline">
        {rows.map(([title, when, tz, count, snippet, id], i) => (
          <li key={i} className="timeline-item" data-conversation={id}>
            <div className="timeline-marker" />
            <div className="timeline-body">
              <div className="timeline-head">
                <span className="timeline-title">{title}</span>
                <span className="timeline-when">
                  {when} <span className="tz">{tz}</span>
                </span>
              </div>
              <div className="timeline-snippet">{snippet}</div>
              <div className="timeline-meta">{count} messages</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};

const StatStripView = ({
  labels,
  values,
  hints,
}: {
  labels: string[];
  values: string[];
  hints: string[];
}) => {
  const rows = zip(labels, values, hints) as string[][];
  return (
    <section className="stats">
      {rows.map(([label, value, hint], i) => (
        <div key={i} className="stat">
          <div className="stat-value">{value}</div>
          <div className="stat-label">{label}</div>
          {hint && <div className="stat-hint">{hint}</div>}
        </div>
      ))}
    </section>
  );
};

const QuickChipsView = ({ chips }: { chips: string[] }) => (
  <div className="chips">
    {chips.map((c) => (
      <button
        key={c}
        className="chip"
        onClick={() => window.dispatchEvent(new CustomEvent("minimi:chip", { detail: c }))}
      >
        {c}
      </button>
    ))}
  </div>
);

/**
 * The root container. Children arrive as parsed sub-component values, not as
 * React nodes, so each one is rendered through OpenUI's `renderNode`.
 */
const ReportView = ({ blocks, renderNode }: { blocks: unknown[]; renderNode: (v: unknown) => React.ReactNode }) => (
  <div className="report">
    {(blocks ?? []).map((b, i) => (
      <React.Fragment key={i}>{renderNode(b)}</React.Fragment>
    ))}
  </div>
);

/** Renderers keyed by component name; schemas come from the shared spec. */
const renderers: Record<string, (props: Record<string, unknown>) => React.ReactNode> = {
  Note: (p) => <NoteView body={String(p.body ?? "")} />,
  AnswerCard: (p) => (
    <AnswerCardView
      body={String(p.body ?? "")}
      citeTitles={(p.citeTitles as string[]) ?? []}
      citeDomains={(p.citeDomains as string[]) ?? []}
      citeUrls={(p.citeUrls as string[]) ?? []}
    />
  ),
  ChangeList: (p) => (
    <ChangeListView
      heading={String(p.heading ?? "")}
      labels={(p.labels as string[]) ?? []}
      statuses={(p.statuses as string[]) ?? []}
      notes={(p.notes as string[]) ?? []}
      froms={(p.froms as string[]) ?? []}
      tos={(p.tos as string[]) ?? []}
      sourceIds={(p.sourceIds as string[]) ?? []}
    />
  ),
  RecallTimeline: (p) => (
    <RecallTimelineView
      heading={String(p.heading ?? "")}
      window={String(p.window ?? "")}
      titles={(p.titles as string[]) ?? []}
      whens={(p.whens as string[]) ?? []}
      tzs={(p.tzs as string[]) ?? []}
      counts={(p.counts as number[]) ?? []}
      snippets={(p.snippets as string[]) ?? []}
      ids={(p.ids as string[]) ?? []}
    />
  ),
  StatStrip: (p) => (
    <StatStripView
      labels={(p.labels as string[]) ?? []}
      values={(p.values as string[]) ?? []}
      hints={(p.hints as string[]) ?? []}
    />
  ),
  QuickChips: (p) => <QuickChipsView chips={(p.chips as string[]) ?? []} />,
  // Report is intentionally absent: it is the root container and is built
  // separately below, because it needs the other components' refs for its schema.
};

// Report needs its children schemas to be the concrete component refs, so it is
// built after the others exist.
const defs = componentSpecs.map((spec) =>
  defineComponent({
    name: spec.name,
    description: spec.description,
    props: spec.schema(),
    // The renderer map is keyed by the same names the spec defines, so this is
    // the one place where the props boundary is dynamic rather than inferred.
    component: ({ props }) =>
      renderers[spec.name]?.(props as unknown as Record<string, unknown>) ?? null,
  }),
);

const ReportComponent = defineComponent({
  name: REPORT_NAME,
  description: REPORT_DESCRIPTION,
  props: z.object({ blocks: z.array(z.union(defs.map((d) => d.ref))) }),
  component: ({ props, renderNode }) => (
    <ReportView blocks={(props.blocks ?? []) as unknown[]} renderNode={renderNode} />
  ),
});

export const clientLibrary = createLibrary({
  components: [ReportComponent, ...defs],
  root: REPORT_NAME,
});
