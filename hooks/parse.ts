import type { Point, PointStatus } from '../types'

// Reads any markdown list of work: `##` headings are sections, top-level list
// lines are points. A point's status comes from, in order: its first status
// emoji or checkbox, a leading capitalised word (DONE, DROPPED, ...), then the
// heading it sits under (Now, Done, Backlog, ...). Anything else is open.

const MARKS: Record<string, PointStatus> = {
  '✅': 'done', '✔️': 'done', '☑️': 'done',
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
  ' ': 'open', x: 'done', X: 'done', '~': 'active', '/': 'active', '-': 'dropped', '?': 'call', '!': 'call',
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
  [/\b(backlog|later|parked|someday|icebox|post-?live|after launch|future)\b/i, 'later'],
]

const ID_RE = /^(?:\*\*|\[)?([A-Z][A-Z0-9]*-?\d+[a-z]?|#\d+)(?:\*\*|\])?[:.]?(?=\s|$)/

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

  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue

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
      continue
    }

    const item = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/)
    if (!item) continue
    let rest = (item[1] ?? '').trim()
    let status: PointStatus | null = null
    let isUrgent = false

    const box = rest.match(/^\[(.)\]\s*/)
    const boxStatus = box ? BOXES[box[1] ?? ''] : undefined
    if (box && boxStatus) {
      status = boxStatus
      rest = rest.slice(box[0].length)
    }

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
      id = idMatch[1] ?? null
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
    const last: Raw = { id, title, section, isUrgent, hasExplicit, status: status ?? subStatus ?? sectionStatus ?? 'open' }
    out.push(last)
    // An explicit "open" mark under a Later or Done heading still follows the heading.
    if (last.status === 'open' && hasExplicit) last.status = subStatus ?? sectionStatus ?? 'open'
    if (last.status === 'active' && (subStatus ?? sectionStatus) === 'later') last.status = 'later'
  }

  // When most points carry an id, lines without one are notes, not points.
  const withId = out.filter(p => p.id).length
  const kept = withId * 2 >= out.length && withId > 0 ? out.filter(p => p.id) : out
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

export const CANDIDATES = [
  'OPEN-POINTS.md',
  'docs/OPEN-POINTS.md',
  'docs/product/OPEN-POINTS.md',
  'TODO.md',
  'docs/TODO.md',
  'TASKS.md',
]
