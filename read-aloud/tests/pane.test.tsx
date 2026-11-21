import { expect, test } from 'claude-code/testing'

import { blocksOf, forSpeech } from '../hooks/register'

const PANE = {
  plugin: 'read-aloud',
  component: 'Pane',
  requestId: 'now-reading',
  props: {
    title: 'Now reading',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const MESSAGE = [
  'First paragraph has **bold** words. It has two sentences.',
  '',
  '- A bullet point.',
  '',
  '```bash',
  'echo never read',
  '```',
  '',
  'After the code.',
].join('\n')

test('code is never read; list markers and markup are dropped from speech', () => {
  const blocks = blocksOf(MESSAGE)
  expect(blocks.map(block => block.sentences)).toEqual([
    ['First paragraph has bold words.', 'It has two sentences.'],
    ['A bullet point.'],
    [],
    ['After the code.'],
  ])
  expect(forSpeech('1. Step one')).toBe('Step one')
})

test('the Now reading pane draws the message as written, read blocks greyed out, later ones in full colour', async ($, on) => {
  const blocks = [
    { markdown: 'First paragraph has **bold** words. It has two sentences.', from: 0, to: 2 },
    { markdown: '- A bullet point.', from: 2, to: 3 },
    { markdown: '```bash\necho never read\n```', from: 3, to: 3 },
    { markdown: 'After the code.', from: 3, to: 4 },
  ]
  const piece = {
    id: 'turn:1',
    seq: 1,
    sentences: ['First paragraph has bold words.', 'It has two sentences.', 'A bullet point.', 'After the code.'],
    blocks,
    progress: 1,
  }
  on('state.get', (_, e) => {
    const values: Record<string, unknown> = {
      pending: { shape: 'pending-sentences-1', value: [piece] },
      speaking: 'turn:1',
      speed: 1.6,
    }
    return { value: { value: values[e.key], version: 1 } }
  })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    const all = JSON.stringify(await ui.drawn())
    // The block being read: only its current sentence is a link, and it is not dimmed.
    expect(all).toContain('First paragraph has **bold** words. [It has two sentences.](https://read-aloud.invalid/sentence/1)')
    // Blocks after it: plain text in full colour, a ▶ to start there (none on code).
    expect(all).toContain('"text":"- A bullet point."')
    expect(all).toContain('echo never read')
    expect(await ui.find({ type: 'Button', key: 'from-1' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'from-0' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'from-2' })).toBeUndefined()
    const after = await ui.findAll({ type: 'Markdown' })
    expect(after.every(one => !one.props.dimColor)).toBe(true)
    await ui.unmount()
  }
})
