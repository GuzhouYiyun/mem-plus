// Deterministic time-window parsing (companion-plan §3 Phase 3 item 2).
//
// WHAT IT DOES
//   A query like "上个月我们定的方案" or "what did we decide in 2025" carries a
//   time range in words. The `memory_search` tool already accepts `since`/`until`
//   (YYYY-MM-DD), but the model has to remember to translate the phrase itself.
//   This parser does the translation deterministically and merges it into the
//   filters, so a time-scoped question searches a time-scoped window even when the
//   caller passed no dates.
//
// WHY NO MODEL
//   LongMemEval-style time-aware query expansion asks a model to rewrite the query,
//   and the chain's own caveat (§11, weak models) says that can degrade. Calendar
//   arithmetic on a fixed phrase list is total, offline, and the same in every
//   language the list covers (zh-Hans and en, the two the recall-intent gate has
//   always keyed on). Unknown phrasings ("上次", "之前") get NO window rather than
//   a guessed one -- a wrong window silently hides the right memory, which is worse
//   than no window.
//
// FIRST MATCH WINS, in the order below: specific days before weeks, weeks before
// months, months before years. A query mentioning two ranges is out of scope.
//
// DIVERGENCE: upstream never derives filters from query text. Recorded in
// docs/port-plan.md, cites memory-chain.md §1b (the decay this complements).

export type TimeWindow = {
  readonly since: string;
  readonly until: string;
  /** The matched phrase, for the log line. */
  readonly phrase: string;
  /**
   * The query with the matched phrase cut out, for the keyword lane. WHY THIS
   * EXISTS: FTS terms are ANDed, and the phrase is a term like any other --
   * `memory_search {"上个月 记忆"}` required chunks to literally contain the token
   * 上个月 on top of the window it had already bought, and matched nothing. Measured
   * live 2026-11-07 even after the day-column fix: the window was derived and the
   * corpus carried the hits; the residual term killed the query. The window is the
   * phrase's translation; the term is not paid for twice.
   */
  readonly residual: string;
};

const DAY_MS = 86_400_000;

function fmt(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function day(nowMs: number, offsetDays = 0): Date {
  return new Date(nowMs - offsetDays * DAY_MS);
}

/** Monday of the week containing `date` (locale-independent, ISO convention). */
function weekStart(date: Date): Date {
  const shifted = new Date(date.getTime());
  const weekday = (shifted.getDay() + 6) % 7; // Mon=0 .. Sun=6
  shifted.setDate(shifted.getDate() - weekday);
  return shifted;
}

const CN_NUM: Record<string, number> = {
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

/** "N天/周/月/年前" in digits or the single-character Chinese numerals. */
function parseAgoOffset(query: string): { days: number; phrase: string } | null {
  const numeric = query.match(/(\d+)\s*(天|日|个?月|周|星期|年)\s*(以?前|ago)/u);
  const chinese = query.match(/([一两二三四五六七八九十]+)\s*(天|日|个?月|周|星期|年)\s*(以?前|ago)/u);
  const raw = numeric?.[1] ?? chinese?.[1] ?? null;
  const unit = numeric?.[2] ?? chinese?.[2] ?? null;
  const phrase = numeric?.[0] ?? chinese?.[0] ?? null;
  if (raw === null || unit === null || phrase === null) return null;
  const count = /^\d+$/u.test(raw) ? Number(raw) : (CN_NUM[raw] ?? null);
  if (count === null || count <= 0) return null;
  // `个?月` captures "个月"; the measure word has to come off before the unit
  // dispatch, or "3个月前" reads as "个...前" and falls into the year branch.
  const u = unit.replace(/^个/, "");
  if (u === "天" || u === "日") return { days: count, phrase };
  if (u === "周" || u === "星期") return { days: count * 7, phrase };
  if (u === "月") return { days: Math.round(count * 30.44), phrase };
  return { days: Math.round(count * 365.25), phrase };
}

type Rule = {
  readonly pattern: RegExp;
  readonly window: (nowMs: number, match: RegExpMatchArray) => { since: string; until: string };
};

const RULES: readonly Rule[] = [
  // Named days.
  { pattern: /今天|today/u, window: (n) => ({ since: fmt(day(n)), until: fmt(day(n)) }) },
  {
    pattern: /昨天|yesterday/u,
    window: (n) => ({ since: fmt(day(n, 1)), until: fmt(day(n, 1)) }),
  },
  {
    pattern: /前天|day before yesterday/u,
    window: (n) => ({ since: fmt(day(n, 2)), until: fmt(day(n, 2)) }),
  },
  // Weeks: Monday-prefixed, inclusive of the weekend.
  {
    pattern: /(?:这|本)(?:个)?周|这个星期|本周|this (?:week)/u,
    window: (n) => {
      const start = weekStart(day(n));
      const end = new Date(start.getTime());
      end.setDate(end.getDate() + 6);
      return { since: fmt(start), until: fmt(end) };
    },
  },
  {
    pattern: /上(?:个)?(?:周|星期)|last week/u,
    window: (n) => {
      const start = weekStart(day(n, 7));
      const end = new Date(start.getTime());
      end.setDate(end.getDate() + 6);
      return { since: fmt(start), until: fmt(end) };
    },
  },
  // Calendar months.
  {
    pattern: /(?:这|本)(?:个)?月|this month/u,
    window: (n) => {
      const base = day(n);
      return {
        since: fmt(new Date(base.getFullYear(), base.getMonth(), 1)),
        until: fmt(new Date(base.getFullYear(), base.getMonth() + 1, 0)),
      };
    },
  },
  {
    pattern: /上(?:个)?月|last month/u,
    window: (n) => {
      const base = day(n);
      return {
        since: fmt(new Date(base.getFullYear(), base.getMonth() - 1, 1)),
        until: fmt(new Date(base.getFullYear(), base.getMonth(), 0)),
      };
    },
  },
  // Explicit offset days ("3天前", "two weeks ago" stays unhandled: word-numbers in
  // English are a tail we refuse to guess, per the header's unknown-phrase rule).
  {
    pattern: /(?:\d+|[一两二三四五六七八九十]+)\s*(?:天|日|个?月|周|星期|年)\s*(?:以?前|ago)/u,
    window: (n, match) => {
      const offset = parseAgoOffset(match[0] ?? "");
      const value = fmt(day(n, offset?.days ?? 0));
      return { since: value, until: value };
    },
  },
  // Calendar years.
  {
    pattern: /今年|this year/u,
    window: (n) => {
      const base = day(n);
      return {
        since: fmt(new Date(base.getFullYear(), 0, 1)),
        until: fmt(new Date(base.getFullYear(), 11, 31)),
      };
    },
  },
  {
    pattern: /去年|last year/u,
    window: (n) => {
      const year = day(n).getFullYear() - 1;
      return {
        since: fmt(new Date(year, 0, 1)),
        until: fmt(new Date(year, 11, 31)),
      };
    },
  },
  {
    pattern: /(\d{4})\s*年|(?:in|during|of)\s+(\d{4})|\b(20\d{2})\b/u,
    window: (_n, match) => {
      const year = Number(match[1] ?? match[2] ?? match[3]);
      return {
        since: fmt(new Date(year, 0, 1)),
        until: fmt(new Date(year, 11, 31)),
      };
    },
  },
];

/**
 * The window a temporal phrase asks for, or null when the query says nothing about
 * time. `nowMs` is injectable so probes run against a fixed calendar.
 */
export function parseQueryTimeWindow(query: string, nowMs: number = Date.now()): TimeWindow | null {
  for (const rule of RULES) {
    const match = query.match(rule.pattern);
    if (!match) continue;
    const bounds = rule.window(nowMs, match);
    const at = match.index ?? 0;
    const residual = `${query.slice(0, at)} ${query.slice(at + match[0].length)}`
      .replace(/\s+/gu, " ")
      .trim();
    return { ...bounds, phrase: match[0].trim(), residual };
  }
  return null;
}
