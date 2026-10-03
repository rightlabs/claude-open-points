import { expect, test } from 'claude-code/testing'

import { counts, parsePoints } from '../hooks/parse'

const ID_LIST = `# Open points

## R: Your calls (each unblocks work)
- **R7** ⏸️ 🔴 **Review the answer key.** Long text here.
- **R32** 🔜 **Landing fixes.** More text.
- **R1** ✅ **Ask home v2.** Done text.
- **Closed old questions (for the record):** a note, not a point.

## BE: backend
- **BE-8** **Handoff notes.** Not marked at all.
- **BE-9** 🔎 **Reading receipt.** Built.
- **BE-10** 🔨 **Thread rule.** In progress.
- **BE-11** ➡️ **Merged one.** MERGED into BE-10.
- FE-35 note: an annotation, not a point.

## P: post-live (after launch)
### Feature requests
- **P4** **Share the receipt.** Later.
`

const CHECKBOX_LIST = `# TODO

## Now
- [ ] Build the thing

## Next
- [ ] Write the docs
- [~] Half done refactor
- [?] Pick a database

## Backlog
- [ ] Someday idea

## Done
- [x] Shipped login
\`\`\`
- [ ] inside a code fence, ignored
\`\`\`
`

test('reads an id list by its marks and headings', async () => {
  const points = parsePoints(ID_LIST)
  const byId = Object.fromEntries(points.map(p => [p.id, p]))

  expect(points.map(p => p.id)).toEqual(['R7', 'R32', 'R1', 'BE-8', 'BE-9', 'BE-10', 'BE-11', 'P4'])
  expect(byId.R7?.status).toBe('call')
  expect(byId.R7?.isUrgent).toBe(true)
  expect(byId.R7?.title).toBe('Review the answer key')
  expect(byId.R7?.section).toBe('R: Your calls')
  expect(byId.R32?.status).toBe('open')
  expect(byId.R1?.status).toBe('done')
  expect(byId['BE-8']?.status).toBe('open')
  expect(byId['BE-9']?.status).toBe('check')
  expect(byId['BE-10']?.status).toBe('active')
  expect(byId['BE-11']?.status).toBe('dropped')
  expect(byId.P4?.status).toBe('later')
})

test('reads a checkbox list by its boxes and headings', async () => {
  const points = parsePoints(CHECKBOX_LIST)
  const status = Object.fromEntries(points.map(p => [p.title, p.status]))

  expect(points.length).toBe(6)
  expect(status['Build the thing']).toBe('active')
  expect(status['Write the docs']).toBe('open')
  expect(status['Half done refactor']).toBe('active')
  expect(status['Pick a database']).toBe('call')
  expect(status['Someday idea']).toBe('later')
  expect(status['Shipped login']).toBe('done')
  expect(counts(points).done).toBe(1)
})

test('the band counts what needs you, read from the project list', async ($, on) => {
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  on('session.cwd', async () => ({ value: '/project' }))
  on('store.get', async () => ({ value: undefined }))
  on('fs.exists', async (_, e) => ({ value: e.path.endsWith('/OPEN-POINTS.md') && !e.path.includes('/docs/') }))
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: ID_LIST.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', async () => ({ value: ID_LIST }))
  on('clock.every', async () => ({ value: undefined }))
  on('ui.render', async () => null as never)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true } as never)

  const ui = await $.ui.mount({
    plugin: 'open-points',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 3,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 3 },
      view: {},
    },
  })

  expect(await ui.find({ type: 'Text', text: /2 need you/ })).toBeDefined()
  expect(await ui.find({ key: 'open' })).toBeDefined()
  await ui.unmount()
})

test('the pane draws coloured groups and folds the closed ones', async ($, on) => {
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  on('session.cwd', async () => ({ value: '/project' }))
  on('store.get', async () => ({ value: undefined }))
  on('fs.exists', async (_, e) => ({ value: e.path.endsWith('/OPEN-POINTS.md') && !e.path.includes('/docs/') }))
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: ID_LIST.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', async () => ({ value: ID_LIST }))
  on('clock.every', async () => ({ value: undefined }))
  on('clock.now', async () => ({ value: 120_000 }))
  on('ui.render', async () => null as never)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true } as never)

  const ui = await $.ui.mount({
    plugin: 'open-points',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'open-points',
    props: {
      title: 'Open points',
      isFocused: false,
      bodyColumns: 70,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })

  expect(await ui.find({ type: 'Text', text: /Needs your call/ })).toBeDefined()
  expect(await ui.find({ key: 'go-call-R7' })).toBeDefined()
  expect(await ui.find({ key: 'go-done-R1' })).toBeUndefined()
  await ui.press({ key: 'toggle-done' })
  expect(await ui.find({ key: 'go-done-R1' })).toBeDefined()
  await ui.unmount()
})

test('reads the common to-do formats', async () => {
  const of = (md: string) => parsePoints(md).map(p => `${p.status}:${p.id ?? ''}:${p.title}:${p.section}`)

  expect(of('- [ ] Write the README\n* [x] Set up CI\n1. [ ] Numbered task\n- [ ]\n')).toEqual([
    'open::Write the README:', 'done::Set up CI:', 'open::Numbered task:',
  ])
  expect(of('### Todo\n- [ ] Design the API\n### In Progress\n- [ ] Auth flow\n### Done ✓\n- [x] Repo setup\n')).toEqual([
    'open::Design the API:', 'active::Auth flow:', 'done::Repo setup:',
  ])
  const obsidian = parsePoints('- [ ] Write report 📅 2026-10-05 ⏫\n- [x] Pay rent ✅ 2026-10-01\n- [>] Moved on\n')
  expect(obsidian.map(p => [p.title, p.status, p.isUrgent])).toEqual([
    ['Write report', 'open', true], ['Pay rent', 'done', false], ['Moved on', 'later', false],
  ])
  expect(of('---\ntags:\n- work\n---\r\n<!--\n- [ ] hidden\n-->\r\n## Open\r\n- [ ] Real task\r\n')).toEqual([
    'open::Real task:Open',
  ])
  expect(of('## Q4\n- Website\n  - [ ] New hero\n- [ ] Task\n  - [ ] subtask\n')).toEqual([
    'open::New hero:Q4 · Website', 'open::Task:Q4',
  ])
  expect(of('- Q3 planning review\n- V2 of the onboarding\n')).toEqual(['open::Q3 planning review:', 'open::V2 of the onboarding:'])
  expect(of('- [ ] ABC-123 Fix the test\n- [ ] #42 Docs typo\n- [ ] R7: Pick a name\n- [ ] Untracked chore\n')).toEqual([
    'open:ABC-123:Fix the test:', 'open:#42:Docs typo:', 'open:R7:Pick a name:', 'open::Untracked chore:',
  ])
})
