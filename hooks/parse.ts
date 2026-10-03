import type { Point, PointStatus } from '../types'

// Reads any markdown list of work: `##` headings are sections, top-level list
// lines are points. A point's status comes from, in order: its first status
// emoji or checkbox, a leading capitalised word (DONE, DROPPED, ...), then the
// heading it sits under (Now, Done, Backlog, ...). Anything else is open.

const MARKS: Record<string, PointStatus> = {
  '✅': 'done', '✔️': 'done', '✔': 'done', '☑️': 'done', '☑': 'done', '✓': 'done',
  '🔎': 'check', '👀': 'check',
  '⏸️': 'call', '⏸': 'call', '❓': 'call', '🚫': 'call', '⛔': 'call',
  '🔨': 'active', '⏳': 'active', '🚧': 'active', '🏗️': 'active',
  '🔜': 'open', '🆕': 'open',
  '❌': 'dropped', '➡️': 'dropped', '🗑️': 'dropped',
}
const FLAGS = ['🔴', '🔥', '❗', '‼️']
const MARK_RE = new RegExp(
  `^(?:${[...Object.keys(MARKS), ...FLAGS].map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
  'u',
)

const BOXES: Record<string, PointStatus> = {
  ' ': 'open', x: 'done', X: 'done', '~': 'active', '/': 'active', '-': 'dropped', '?': 'call', '!': 'call', '>': 'later', '<': 'later',
}

const WORDS: Array<[RegExp, PointStatus]> = [
  [/^(DONE|CLOSED|SHIPPED|CHECKED|RESOLVED|FIXED)\b/, 'done'],
  [/^(DROPPED|MERGED|MOVED|WONTFIX|CANCELL?ED|DUPLICATE|FOLDED)\b/, 'dropped'],
  [/^(AWAITING\b.*\b(CHECK|REVIEW)|REVIEW|VERIFY)\b/, 'check'],
  [/^(BLOCKED|QUESTION|DECIDE|FINDING|NEEDS?\b)/, 'call'],
  [/^(WIP|DOING|IN PROGRESS|BUILDING)\b/, 'active'],
]

const SECTION_WORDS: Array<[RegExp, PointStatus]> = [
  [/\b(done|completed|finished|shipped|closed|archive)\b/i, 'done'],
  [/\b(dropped|cancell?ed|won'?t do)\b/i, 'dropped'],
  [/\b(now|doing|in progress|active|current)\b/i, 'active'],
  [/\b(review|to check|waiting)\b/i, 'check'],
  [/\b(blocked|questions?|decisions?)\b/i, 'call'],
  [/\b(backlog|later|parked|someday|icebox|post-?live|after launch|future|ideas?|maybe|nice to have)\b/i, 'later'],
]

// An id leads a point: bold or bracketed (`**R7**`, `[R7]`), hyphenated (`API-4`),
// an issue number (`#42`), or followed by a colon (`R7: ...`). A bare "Q3" or "V2"
// opening a sentence is not one.
const ID_RE =
  /^(?:\*\*([A-Z][A-Z0-9]*-?\d+[a-z]?)\*\*[:.]?|\[([A-Z][A-Z0-9]*-?\d+[a-z]?)\][:.]?|([A-Z][A-Z0-9]*-\d+[a-z]?)[:.]?|(#\d+)[:.]?|([A-Z][A-Z0-9]*\d+[a-z]?):)(?=\s|$)/

// Obsidian Tasks fields: dates and priority marks trail the task's words.
const TASK_FIELDS = /\s*(?:[📅⏳🛫✅➕❌]\uFE0F?\s*\d{4}-\d{2}-\d{2}|🔁\uFE0F?\s*every\b[^📅⏳🛫✅➕❌]*|[⏫🔼🔽⏬🔺])/gu
const URGENT_FIELD = /[⏫🔺]/u

export function cleanInline(text: string): string {
  return text
    .replace(/<!--.*?-->/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,;:])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

function sectionName(heading: string): string {
  const plain = cleanInline(heading)
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
  return plain.length > 48 ? `${plain.slice(0, 47)}…` : plain
}

function titleOf(rest: string): { title: string; body: string } {
  const bold = rest.match(/^\*\*(.+?)\*\*\s*(.*)$/)
  if (bold) return { title: cleanInline(bold[1] ?? '').replace(/[.:]$/, ''), body: bold[2] ?? '' }
  const plain = cleanInline(rest)
  const cut = plain.search(/(?<=[a-z0-9)])\.\s|\s[—–]\s|:\s/)
  const title = cut > 0 ? plain.slice(0, cut) : plain
  return { title: title.length > 120 ? `${title.slice(0, 119)}…` : title, body: plain.slice(title.length) }
}

type Raw = Point & { hasExplicit: boolean }

export function parsePoints(markdown: string): Point[] {
  const out: Raw[] = []
  let section = ''
  let sectionStatus: PointStatus | null = null
  let subStatus: PointStatus | null = null
  let inFence = false
  let inComment = false
  // The last top-level point, while it can still turn out to be a project heading
  // for checkbox tasks nested under it.
  let parent: { raw: Raw; isPlain: boolean } | null = null
  const projects = new Set<Raw>()
  const lines = markdown.split(/\r?\n/)

  // Front matter is settings, not points.
  let from = 0
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l))
    if (close > 0) from = close + 1
  }

  for (const line of lines.slice(from)) {
    if (inComment) {
      if (line.includes('-->')) inComment = false
      continue
    }
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    if (line.includes('<!--') && !line.slice(line.indexOf('<!--')).includes('-->')) {
      inComment = true
      if (/^\s*<!--/.test(line)) continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      const level = (heading[1] ?? '').length
      const text = heading[2] ?? ''
      const status = SECTION_WORDS.find(([re]) => re.test(text))?.[1] ?? null
      if (level <= 2) {
        section = level === 1 ? '' : sectionName(text)
        sectionStatus = level === 1 ? null : status
        subStatus = null
      } else {
        subStatus = status
      }
      parent = null
      continue
    }

    const item = line.match(/^([ \t]*)(?:[-*+]|\d+[.)])\s+(.*)$/)
    if (!item) continue
    const indent = (item[1] ?? '').replace(/\t/g, '    ').length
    let rest = (item[2] ?? '').trim()
    let status: PointStatus | null = null
    let isUrgent = false

    const box = rest.match(/^\[(.)\]\s*/)
    const boxStatus = box ? BOXES[box[1] ?? ''] : undefined
    if (box && boxStatus) {
      status = boxStatus
      rest = rest.slice(box[0].length)
    }

    // Nested lines are details of their point, except checkbox tasks under a plain
    // bullet, which then reads as a project name.
    let nestedUnder: string | null = null
    if (indent > 0) {
      if (!box || !parent?.isPlain) continue
      projects.add(parent.raw)
      nestedUnder = parent.raw.title
    }

    if (URGENT_FIELD.test(rest)) isUrgent = true
    rest = rest.replace(TASK_FIELDS, '')

    let id: string | null = null
    const takeMarks = () => {
      for (let m = rest.match(MARK_RE); m; m = rest.match(MARK_RE)) {
        if (FLAGS.includes(m[0])) isUrgent = true
        else status ??= MARKS[m[0]] ?? null
        rest = rest.slice(m[0].length).trimStart()
      }
    }
    takeMarks()
    const idMatch = rest.match(ID_RE)
    if (idMatch) {
      id = idMatch.slice(1).find(Boolean) ?? null
      rest = rest.slice(idMatch[0].length).trimStart()
    }
    takeMarks()

    // `- ID note: ...` annotates a point; it is not one.
    if (id && /^[a-z][\w-]*:\s/.test(rest)) continue
    const { title, body } = titleOf(rest)
    if (!title) continue
    if (!status) {
      const head = cleanInline(body).replace(/^\([^)]*\)\s*/, '')
      status = WORDS.find(([re]) => re.test(head))?.[1] ?? null
    }
    const hasExplicit = status !== null
    const where = nestedUnder ? (section ? `${section} · ${nestedUnder}` : nestedUnder) : section
    const raw: Raw = { id, title, section: where, isUrgent, hasExplicit, status: status ?? subStatus ?? sectionStatus ?? 'open' }
    // An explicit "open" mark under a Later or Done heading still follows the heading.
    if (raw.status === 'open' && hasExplicit) raw.status = subStatus ?? sectionStatus ?? 'open'
    if (raw.status === 'active' && (subStatus ?? sectionStatus) === 'later') raw.status = 'later'
    out.push(raw)
    if (!nestedUnder) parent = { raw, isPlain: !box && !hasExplicit && !id }
  }

  // A plain bullet that holds checkbox tasks is their project, not a point.
  const points = out.filter(p => !projects.has(p))
  // When most points carry an id, unmarked lines without one are notes.
  const withId = points.filter(p => p.id).length
  const kept = withId > 0 && withId * 2 >= points.length ? points.filter(p => p.id || p.hasExplicit) : points
  return kept.map(({ hasExplicit: _, ...p }) => p)
}

export const ORDER: PointStatus[] = ['check', 'call', 'active', 'open', 'later', 'done', 'dropped']

export const LABELS: Record<PointStatus, string> = {
  check: 'Waiting for your check',
  call: 'Needs your call',
  active: 'Being built',
  open: 'Open, not started',
  later: 'Later',
  done: 'Done',
  dropped: 'Dropped or merged',
}

export function counts(points: Point[]): Record<PointStatus, number> {
  const c = { check: 0, call: 0, active: 0, open: 0, later: 0, done: 0, dropped: 0 }
  for (const p of points) c[p.status] += 1
  return c
}

const NAMES = ['OPEN-POINTS.md', 'open-points.md', 'TODO.md', 'todo.md', 'TO-DO.md', 'to-do.md', 'TASKS.md', 'tasks.md']
export const CANDIDATES = ['', 'docs/'].flatMap(dir => NAMES.map(name => dir + name))
