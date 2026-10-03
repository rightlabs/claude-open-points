import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Point, PointStatus, PointsDoc } from '../types'
import { CANDIDATES, LABELS, ORDER, counts, parsePoints } from './parse'

const PANE = 'open-points'
const doc = atom({ plugin: 'open-points', key: 'doc' } as const, null)
const error = atom({ plugin: 'open-points', key: 'error' } as const, null)
const expanded = atom({ plugin: 'open-points', key: 'expanded' } as const, [])

const COLLAPSED: PointStatus[] = ['later', 'done', 'dropped']

const COLORS: Record<PointStatus, string> = {
  check: 'cyan',
  call: 'yellow',
  active: 'magenta',
  open: 'blue',
  later: 'gray',
  done: 'green',
  dropped: 'gray',
}

function fit(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

async function storeKey($: EngineInterface): Promise<string> {
  return `file:${await $.session.cwd()}`
}

async function findFile($: EngineInterface, configured: string): Promise<string | null> {
  const chosen = (await $.store.get(await storeKey($))) as string | undefined
  if (chosen) return chosen
  if (configured) return configured
  for (const path of CANDIDATES) {
    if (await $.fs.exists(path)) return path
  }
  return null
}

async function refresh($: EngineInterface, configured: string, force = false): Promise<void> {
  const path = await findFile($, configured)
  if (!path) {
    if ((await read($, doc)) !== null) await update($, doc, () => null)
    return
  }
  try {
    const { mtimeMs } = await $.fs.stat(path)
    const current = await read($, doc)
    if (!force && current && current.path === path && current.mtimeMs === mtimeMs) return
    const points = parsePoints(await $.fs.read(path))
    const next: PointsDoc = { path, mtimeMs, points }
    await update($, doc, () => next)
    if ((await read($, error)) !== null) await update($, error, () => null)
  } catch (err) {
    const message = `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`
    if ((await read($, error)) !== message) await update($, error, () => message)
  }
}

async function insert($: EngineInterface, point: Point) {
  await $.prompt.fill({ text: `${point.id ?? point.title} `, mode: 'insert' })
}

export const register: Register = (on, options) => {
  const configured = String(options.file ?? '').trim()
  const showBand = options.showBand !== false
  const openOnStart = options.openPaneOnStart === true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'open-points',
      description: 'Show the open points pane. Args: a file path to use for this project, "auto", or "refresh"',
      argumentHint: '[path | auto | refresh]',
    })
    await refresh($, configured, true)
    $.clock.every(2000, () => void refresh($, configured))
    if (openOnStart && (await read($, doc))) void $.ui.open({ id: PANE, title: 'Open points' })

    return next(e)
  })

  on('command.run', { command: 'open-points' }, async ($, e) => {
    const arg = e.args.trim()
    const key = await storeKey($)
    if (arg === 'auto') {
      await $.store.delete(key)
    } else if (arg && arg !== 'refresh') {
      if (!(await $.fs.exists(arg))) return { text: `No file at ${arg}.` }
      await $.store.set(key, arg)
    }
    await refresh($, configured, true)
    const current = await read($, doc)
    if (!current) {
      return { text: `No list found. Looked for ${CANDIDATES.join(', ')}. Run /open-points <path> to pick one.` }
    }
    await $.ui.open({ id: PANE, title: 'Open points' })
    const c = counts(current.points)

    return {
      text: `${current.path}: ${c.check + c.call} need you, ${c.active} being built, ${c.open} open, ${c.done} done.`,
    }
  })

  // Rereads at once when Claude edits the list itself.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.tool === 'Edit' || e.tool === 'Write') void refresh($, configured)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, doc)
    const problem = await read($, error)
    const open = await read($, expanded)
    const width = Math.max(24, (e.props.bodyColumns ?? 60) - 1)

    if (!current) {
      return (
        <Box flexDirection="column">
          <Text>No list found.</Text>
          <Text dimColor wrap="wrap">Looked for {CANDIDATES.join(', ')}. Run /open-points &lt;path&gt;.</Text>
        </Box>
      )
    }

    const now = await $.clock.now()
    const c = counts(current.points)
    const idWidth = Math.max(0, ...current.points.map(p => (p.id ?? '').length)) + 1
    const toggle = (status: PointStatus) =>
      update($, expanded, list => (list.includes(status) ? list.filter(s => s !== status) : [...list, status]))

    const group = (status: PointStatus) => {
      const points = current.points.filter(p => p.status === status)
      const sections = [...new Set(points.map(p => p.section))]
      const color = COLORS[status]
      const faded = status === 'done' || status === 'dropped'
      // Border (2) + padding (2) + the urgent dot (2) + the id column.
      const titleWidth = Math.max(8, width - 6 - idWidth)

      return (
        <Box key={status} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color={color}>● {LABELS[status]}</Text>
            <Box>
              <Text color={color}>{points.length} </Text>
              {COLLAPSED.includes(status) && (
                <Button key={`toggle-${status}`} plain dimColor label="hide" onPress={() => toggle(status)} />
              )}
            </Box>
          </Box>
          {sections.map((section, s) => (
            <Box key={`${status}-${section}`} flexDirection="column" marginTop={s === 0 ? 0 : 1}>
              {section && sections.length > 1 && <Text dimColor italic>{fit(section, width - 4)}</Text>}
              {points
                .filter(p => p.section === section)
                .map((point, i) => (
                  <Box key={`${status}-${point.id ?? `${section}-${i}`}`} hover={{ backgroundColor: 'gray' }}>
                    <Text color="red">{point.isUrgent ? '● ' : '  '}</Text>
                    {idWidth > 1 && (
                      <Box width={idWidth} flexShrink={0}>
                        <Text bold={!faded} dimColor={faded} color={faded ? undefined : color}>{point.id ?? ''}</Text>
                      </Box>
                    )}
                    <Button
                      key={`go-${status}-${point.id ?? `${section}-${i}`}`}
                      plain
                      dimColor={faded}
                      label={fit(point.title, titleWidth)}
                      onPress={() => insert($, point)}
                    />
                  </Box>
                ))}
            </Box>
          ))}
        </Box>
      )
    }

    const shown = ORDER.filter(status => c[status] > 0 && (!COLLAPSED.includes(status) || open.includes(status)))
    const folded = COLLAPSED.filter(status => c[status] > 0 && !open.includes(status))

    return (
      <Box flexDirection="column">
        <Text dimColor>{fit(`${current.path} · changed ${ago(now - current.mtimeMs)}`, width)}</Text>
        {problem && <Text color="red" wrap="wrap">{problem}</Text>}
        {current.points.length === 0 && <Text dimColor>No points in this file.</Text>}
        {shown.map(group)}
        {folded.length > 0 && (
          <Box paddingX={2} marginTop={1}>
            {folded.map((status, i) => (
              <Box key={`fold-${status}`}>
                {i > 0 && <Text dimColor> · </Text>}
                <Button key={`toggle-${status}`} plain dimColor label={`${LABELS[status]} ${c[status]} ▸`} onPress={() => toggle(status)} />
              </Box>
            ))}
          </Box>
        )}
        <Box paddingX={2}>
          <Text dimColor>Press a point to put its id in the prompt.</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!showBand || e.props.hasSurvey) return next(e)
    const current = await read($, doc)
    if (!current || current.points.length === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const c = counts(current.points)
    const needYou = c.check + c.call

    return (
      <Box>
        <Text dimColor>Open points </Text>
        <Text bold={needYou > 0} color={needYou > 0 ? 'yellow' : undefined}>{needYou} need you</Text>
        <Text dimColor> · {c.active} being built · {c.open} open </Text>
        <Button key="open" plain dimColor label="[view]" onPress={() => $.ui.open({ id: PANE, title: 'Open points' })} />
      </Box>
    )
  })
}
