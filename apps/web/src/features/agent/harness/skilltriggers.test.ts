import { describe, expect, it } from 'vitest';
import { BUNDLED_SKILLS } from './skills';

// Offline guard for skill descriptions (the only always-on text). A real model matches semantically; this lexical ranker only
// checks that each description carries the trigger vocabulary users actually use, and that no skill steals another's prompts.
// If a case fails, improve the description rather than contorting the prompt.
const STOP = new Set('a an the of to for and or in on with is are be it this that when before after how what why do does i my me you your can please give show write need want from by as at'.split(' '));

function tok(s: string): string[] {
  const out: string[] = [];
  for (const w of s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9_]+/)) {
    if (w.length > 2 && !STOP.has(w)) out.push(w.replace(/(ing|ed|es|s)$/, ''));
  }
  return out;
}

const docs = BUNDLED_SKILLS.map((s) => ({ name: s.name, terms: new Set(tok(s.name.replace(/-/g, ' ') + ' ' + s.description)) }));

function rank(prompt: string, dialect: string) {
  const idf = (w: string) => Math.log(1 + docs.length / (1 + docs.filter((d) => d.terms.has(w)).length));
  const words = tok(prompt);
  return docs
    .filter((d) => !(d.name.startsWith('dialect-') && dialect && d.name !== `dialect-${dialect}`))
    .map((d) => ({ name: d.name, score: words.reduce((n, w) => n + (d.terms.has(w) ? idf(w) : 0), 0) }))
    .sort((a, b) => b.score - a.score);
}

const CASES: Array<[string, string, string]> = [
  ['why is my query slow, can you read the EXPLAIN plan and suggest an index', 'query-performance', ''],
  ['query timeout on a big table, pagination with OFFSET is slow', 'query-performance', ''],
  ['trino exceeded memory limit on this join', 'query-performance', ''],
  ['please review this SQL for mistakes before I run it', 'sql-review', ''],
  ['validate my query: check the joins and aggregation are correct', 'sql-review', ''],
  ['I got ORA-00979 not a GROUP BY expression, fix it', 'error-fixing', ''],
  ['query fails with error: column does not exist', 'error-fixing', ''],
  ['pasted error message from the database, why does it fail', 'error-fixing', ''],
  ['explore this table, what is in it and profile the data quality', 'data-profiling', ''],
  ['profile the null rate and distinct count of each column', 'data-profiling', ''],
  ['draw a chart of revenue per month', 'chart-selection', ''],
  ['make a bar chart or KPI for the dashboard panel', 'chart-selection', ''],
  ['detect outliers and compute the 95th percentile with a moving average', 'analysis-stats', ''],
  ['cohort retention and funnel conversion trend', 'analysis-stats', ''],
  ['remember this definition: active merchant means status ACTIVE, learn the business context of this database', 'data-context', ''],
  ['let me explain what this metric means so you learn it, onboard this database', 'data-context', ''],
  ['write a query joining orders and customers with window functions and dedupe', 'sql-authoring', ''],
  ['write SQL aggregation with CTE and safe row limit', 'sql-authoring', ''],
  ['how do I limit rows and format dates in Oracle', 'dialect-oracle', 'oracle'],
  ['Oracle SQL pagination and string aggregation syntax', 'dialect-oracle', 'oracle'],
  ['PostgreSQL jsonb and DISTINCT ON syntax', 'dialect-postgresql', 'postgresql'],
  ['trino date functions and UNNEST arrays', 'dialect-trino', 'trino'],
];

describe('skill descriptions', () => {
  it.each(CASES)('%s -> %s', (prompt, want, dialect) => {
    const r = rank(prompt, dialect);
    expect(r[0]!.name).toBe(want);
    expect(r[0]!.score).toBeGreaterThan(r[1]!.score);
  });
  it('every skill is the expected winner of at least one case', () => {
    const covered = new Set(CASES.map((c) => c[1]));
    expect(BUNDLED_SKILLS.filter((s) => !covered.has(s.name)).map((s) => s.name)).toEqual([]);
  });
});
