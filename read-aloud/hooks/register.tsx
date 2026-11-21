import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Block, Pending, PlayMode } from '../types'

const isOn = atom({ plugin: 'read-aloud', key: 'isOn' } as const, false)
// The tag declines queues an earlier version stored (whole texts, no sentences).
const pending = atom({ plugin: 'read-aloud', key: 'pending' } as const, [] as Pending[], {
  shape: 'pending-sentences-1',
})
const history = atom({ plugin: 'read-aloud', key: 'history' } as const, [] as Pending[], {
  shape: 'history-1',
})
const MAX_HISTORY = 200
const speed = atom({ plugin: 'read-aloud', key: 'speed' } as const, 1)
const speaking = atom({ plugin: 'read-aloud', key: 'speaking' } as const, null as string | null)
const mode = atom({ plugin: 'read-aloud', key: 'mode' } as const, null as PlayMode)
const isConversational = atom({ plugin: 'read-aloud', key: 'isConversational' } as const, false)
const isFollowing = atom({ plugin: 'read-aloud', key: 'isFollowing' } as const, false)
const PANE = 'now-reading'

// Added to the system prompt while Conversational is on.
const CONVERSATIONAL = {
  id: 'read-aloud:conversational',
  scope: 'session',
  text: [
    '# Conversational replies',
    'The user turned on conversational replies. They often listen to your replies read aloud, and want them to feel like a knowledgeable colleague talking them through the work.',
    'Scope: these rules cover only the text you show the user in the main conversation. Your thinking, planning and checking, tool inputs, the code you write, files, commit messages, pull request text and prompts for subagents all follow their normal conventions and get the same care as always. Never do less work, or less careful work, to make a reply shorter. If you are a subagent, ignore this section and report as usual.',
    'For text shown to the user, these rules take precedence over other formatting guidance:',
    '- Write in plain, flowing sentences and short paragraphs. Explain what you did, why, and what it means for them, in everyday words.',
    '- Prefer describing things over code blocks, tables, headings, command lines and long bullet lists. When the user needs something exact to copy (a command, an error, a path), show it in a code block and say in words what it is for.',
    '- Refer to files by their role ("the settings file"). When the user needs to open, check or fix a file, also give its exact name once.',
    '- Round only approximate quantities ("about two seconds"). Give exact values where they matter: test results ("forty-one passed, two failed"), the name of a failing test, the key words of an error message, versions, and anything the user must act on.',
    '- Keep replies short and offer more detail on request, but never trade correctness for brevity: failures, unresolved problems, risks and choices the user must make are always stated plainly, even if that makes the reply longer.',
    '- When asking to confirm a destructive or outward-facing action, say exactly what will be affected.',
    '- Text you write between tool calls is read aloud while you work. Make it a short spoken note, usually a sentence, about what you found or what you are about to do next. Do not skip it, and do not cut your planning or checking to fit it.',
  ].join('\n'),
} as const

const NORMAL_WPM = 180
const SPEEDS = [0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.5]
const MAX_PENDING = 100
const DEFAULT_VOICE = 'Zoe (Enhanced)'

// Claims playback by writing token $1 to $2, then starts the reader ($3 and the rest:
// see helpers/reader.swift) in the background and returns at once. Any older reading,
// in any session, sees the token change and stops within a few hundredths of a second.
const SPEAK = `printf '%s' "$1" > "$2"; shift 2; "$@" >/dev/null 2>&1 </dev/null &`
// Cuts off whatever is being read, in any session: the reader stops when its token goes.
const STOP = `printf '' > "$1"`
// Builds the reader in the background when it is missing or older than its source.
const BUILD =
  '[ "$2" -nt "$1" ] || { mkdir -p "$(dirname "$2")" && swiftc -O "$1" -o "$2"; } >/dev/null 2>&1 </dev/null &'

// Text as it is spoken: code is never read, markup and list markers are dropped.
export const forSpeech = (text: string) =>
  text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_#>|]/g, '')
    .trim()

// The message's blocks as the chat draws them: a fenced code block (shown, never read),
// a table, or one line (a paragraph, a list item, a heading).
export const blocksOf = (markdown: string) => {
  const out: { markdown: string; sentences: string[] }[] = []
  const lines = markdown.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (/^\s*```/.test(line)) {
      const start = i
      i += 1
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) i += 1
      i += 1
      out.push({ markdown: lines.slice(start, i).join('\n'), sentences: [] })
    } else if (/^\s*\|/.test(line)) {
      const start = i
      while (i < lines.length && /^\s*\|/.test(lines[i] ?? '')) i += 1
      const table = lines.slice(start, i).join('\n')
      out.push({ markdown: table, sentences: sentencesOf(forSpeech(table)) })
    } else {
      i += 1
      if (line.trim() !== '') {
        // Four spaces would draw a lone line as code; keep a nested item's indent short.
        out.push({ markdown: line.replace(/^ {4,}/, '  '), sentences: sentencesOf(forSpeech(line)) })
      }
    }
  }
  return out
}

// A piece's sentences and its blocks with their sentence ranges.
const pieceOf = (markdown: string) => {
  const sentences: string[] = []
  const blocks: Block[] = []
  for (const block of blocksOf(markdown)) {
    blocks.push({ markdown: block.markdown, from: sentences.length, to: sentences.length + block.sentences.length })
    sentences.push(...block.sentences)
  }
  return { sentences, blocks }
}

// A piece's blocks; a piece an earlier version stored has none, so its lines stand in.
const blocksOfPiece = (item: Pending): Block[] => {
  if (item.blocks?.length) return item.blocks
  const starts = item.lineStarts?.length ? item.lineStarts : [0]
  return starts.map((from, n) => {
    const to = starts[n + 1] ?? item.sentences.length
    return { markdown: item.sentences.slice(from, to).join(' '), from, to }
  })
}

// In the Now reading pane the sentence being read is drawn as a link: a link changes the
// colour, never the width, so nothing rewraps, and a click on it restarts it. (Links are
// blue even in greyed-out text, and a hover may only move a floating element, so other
// sentences stay plain.) A sentence that does not stand verbatim in the markdown (it
// holds markup) stays plain.
const SENTENCE_LINK = 'https://read-aloud.invalid/sentence/'
export const withSentenceLinks = (markdown: string, block: Block, sentences: string[], only?: number) => {
  let out = ''
  let rest = markdown
  for (let index = block.from; index < block.to; index += 1) {
    const sentence = sentences[index]
    if (!sentence || /[[\]]/.test(sentence)) continue
    const at = rest.indexOf(sentence)
    if (at < 0) continue
    const text = only === undefined || only === index ? `[${sentence}](${SENTENCE_LINK}${index})` : sentence
    out += rest.slice(0, at) + text
    rest = rest.slice(at + sentence.length)
  }
  return out + rest
}

export const sentencesOf = (text: string) =>
  text
    .split(/(?<=[.!?:])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => /[\p{L}\p{N}]/u.test(s))

// Module variables, set again by session.start after each reload.
let dir = ''
let sessionId = ''
let voice = DEFAULT_VOICE
let lastStatus = ''
// The transcript row each reply was last drawn in, keyed by its text, for Jump.
const rowOf = new Map<string, string>()
// The run being followed: each reading gets its own, so a report from a run that was
// replaced (a restart of the same piece) is ignored.
let runId = ''
// Sentences of each drawn reply, keyed by their joined text.
const rowPieces = new Map<string, { sentences: string[]; blocks: Block[] }>()

const activeFile = () => `${dir}/active-session.json`
const statusFile = () => `${dir}/status-${sessionId}.json`
const rateFile = () => `${dir}/rate`
const tokenFile = () => `${dir}/playing`
const reader = () => `${dir}/reader`

const readJson = async <T,>($: EngineInterface, path: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

const cutOff = ($: EngineInterface) => $.process.run(['/bin/sh', '-c', STOP, 'sh', tokenFile()])

const stopSpeech = async ($: EngineInterface) => {
  await update($, mode, () => null)
  await cutOff($)
  await update($, speaking, () => null)
}

// The session you last worked in (sent a message, pressed a button, ran /read-aloud) is
// written to one file every session shares; only that session reads aloud.
const claimActive = async ($: EngineInterface) => {
  if (!dir) return
  const previous = (await readJson<{ sessionId?: string }>($, activeFile()))?.sessionId
  if (previous && previous !== sessionId) await cutOff($)
  await $.fs.write(activeFile(), JSON.stringify({ sessionId, at: await $.clock.now() }))
}

const isActive = async ($: EngineInterface) => {
  if (!dir) return true
  const active = (await readJson<{ sessionId?: string }>($, activeFile()))?.sessionId
  return !active || active === sessionId
}

const speak = async ($: EngineInterface, item: Pending) => {
  await update($, speaking, () => item.id)
  void followSentence($, item.progress)
  const token = `${sessionId}:${item.id}:${await $.clock.now()}`
  runId = token
  await $.process.run([
    '/bin/sh', '-c', SPEAK, 'sh', token, tokenFile(),
    reader(), runId, voice, statusFile(), rateFile(), tokenFile(), token, String(item.progress),
    ...item.sentences,
  ])
}

// Called on a timer: follows the reading sentence by sentence. Each finished sentence
// moves the piece's progress on; a finished piece leaves the queue and the next one
// plays (live: the next newer piece; catch-up: the oldest). A cut-off sentence
// (mic, Stop, another session) is where Continue picks up.
const checkStatus = async ($: EngineInterface) => {
  if (!dir || (await read($, speaking)) === null) return
  let raw = ''
  try {
    raw = await $.fs.read(statusFile())
  } catch {
    return
  }
  if (raw === lastStatus) return
  lastStatus = raw
  const status = JSON.parse(raw) as { id: string; index: number; code: number; done?: boolean }
  const itemId = await read($, speaking)
  if (status.id !== runId || itemId === null) return

  if (!status.done) {
    await update($, pending, list =>
      list.map(item => (item.id === itemId ? { ...item, progress: status.index } : item)),
    )
    if (status.code === 0) await followSentence($, status.index)
    if (status.code !== 0) {
      await update($, speaking, () => null)
      await update($, mode, () => null)
    }
    return
  }

  await update($, speaking, () => null)
  const list = await read($, pending)
  const finished = list.find(item => item.id === itemId)
  const rest = list.filter(item => item.id !== itemId)
  await update($, pending, () => rest)
  if (finished) await toHistory($, finished)

  const playing = await read($, mode)
  const next =
    playing === 'catchup'
      ? rest[0]
      : playing === 'live' && finished
        ? rest.find(item => item.seq > finished.seq)
        : undefined
  if (next && (await read($, isOn))) await speak($, next)
  else await update($, mode, () => null)
}

// A new piece of text: queued; read now when this is the active session and nothing
// is being read, otherwise it waits its turn (or for Continue).
const arrive = async ($: EngineInterface, id: string, answer: string) => {
  if (!(await read($, isOn))) return
  const { sentences, blocks } = pieceOf(answer)
  if (sentences.length === 0) return

  const item: Pending = { id, seq: await $.clock.now(), sentences, blocks, progress: 0 }
  await update($, pending, list => [...list, item].slice(-MAX_PENDING))

  if ((await read($, speaking)) === null && (await isActive($))) {
    await update($, mode, () => 'live')
    await speak($, item)
  }
}

const setOn = async ($: EngineInterface, value: boolean) => {
  await update($, isOn, () => value)
  await $.store.set('isOn', value)
  if (!value) await stopSpeech($)
}

// Takes effect at the next sentence: the reading loop reads the rate file before each.
const setConversational = async ($: EngineInterface, value: boolean) => {
  await update($, isConversational, () => value)
  await $.store.set('isConversational', value)
}

const setFollowing = async ($: EngineInterface, value: boolean) => {
  await update($, isFollowing, () => value)
  await $.store.set('isFollowing', value)
  if (value) void $.ui.open({ id: PANE, title: 'Now reading' })
  else await $.ui.close({ id: PANE })
}

// Keeps the block being read in view in the Now reading pane.
const followSentence = async ($: EngineInterface, index: number) => {
  if (!(await read($, isFollowing))) return
  const id = await read($, speaking)
  const item = (await read($, pending)).find(one => one.id === id)
  if (!item) return
  const block = blocksOfPiece(item).findIndex(one => index >= one.from && index < one.to)
  if (block < 0) return
  await $.ui.scroll({ to: { key: `b-${block}` }, in: PANE, block: 'center' }).catch(() => undefined)
}

const setSpeed = async ($: EngineInterface, value: number) => {
  await update($, speed, () => value)
  await $.store.set('speed', value)
  if (dir) await $.fs.write(rateFile(), String(Math.round(NORMAL_WPM * value)))
}

// Plays this piece (from where it was cut off, or from `fromSentence`), then the newer
// unread ones after it.
const listenFrom = async ($: EngineInterface, id: string, fromSentence?: number) => {
  await claimActive($)
  if (fromSentence !== undefined) {
    await update($, pending, list =>
      list.map(one => (one.id === id ? { ...one, progress: fromSentence } : one)),
    )
  }
  const item = (await read($, pending)).find(one => one.id === id)
  if (!item) return
  if (!(await read($, isOn))) await setOn($, true)
  await update($, mode, () => 'live')
  await speak($, item)
}

const byText = (text: string) => (one: Pending) => one.sentences.join(' ') === text

const toHistory = async ($: EngineInterface, item: Pending) => {
  const text = item.sentences.join(' ')
  await update($, history, list =>
    [...list.filter(one => one.sentences.join(' ') !== text), { ...item, progress: 0 }].slice(-MAX_HISTORY),
  )
}

const markRead = async ($: EngineInterface, id: string) => {
  if ((await read($, speaking)) === id) await stopSpeech($)
  const item = (await read($, pending)).find(one => one.id === id)
  await update($, pending, list => list.filter(one => one.id !== id))
  if (item) await toHistory($, item)
}

// Puts a reply back in the unread queue, in its place by age: from the history when it is
// there, otherwise (written before the queue knew it) as a new piece from the row's text.
const markUnread = async ($: EngineInterface, text: string): Promise<string | undefined> => {
  const known = (await read($, history)).find(byText(text))
  const item: Pending = known
    ? { ...known, progress: 0 }
    : { id: `row:${await $.clock.now()}`, seq: await $.clock.now(), sentences: [], ...rowPieces.get(text), progress: 0 }
  if (item.sentences.length === 0) return undefined
  await update($, history, list => list.filter(one => one.id !== item.id))
  await update($, pending, list =>
    list.some(byText(text)) ? list : [...list, item].sort((a, b) => a.seq - b.seq).slice(-MAX_PENDING),
  )
  return (await read($, pending)).find(byText(text))?.id
}

const listenFromRow = async ($: EngineInterface, text: string) => {
  const id = await markUnread($, text)
  if (id) await listenFrom($, id)
}

// Scrolls the chat to the top of the reply being read, looked up at the moment of the click.
const jumpToCurrent = async ($: EngineInterface) => {
  const id = await read($, speaking)
  const item = (await read($, pending)).find(one => one.id === id)
  const row = item && rowOf.get(item.sentences.join(' '))
  if (!row) {
    $.ui.toast('That reply is not drawn in the chat right now.')
    return
  }
  const moved = await $.ui.scroll({ to: { requestId: row }, block: 'start' })
  if ('deny' in moved && moved.deny) $.ui.toast(`Could not jump: ${moved.deny}`)
}

const continueReading = async ($: EngineInterface) => {
  await claimActive($)
  const first = (await read($, pending))[0]
  if (!first) return
  await update($, mode, () => 'catchup')
  await speak($, first)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    const home = (await $.process.run(['/usr/bin/printenv', 'HOME'])).stdout.trim()
    if (home) {
      dir = `${home}/.claude/read-aloud`
      await $.process.run(['/bin/sh', '-c', BUILD, 'sh', `${$.plugin.root}/helpers/reader.swift`, reader()])
      lastStatus = await $.fs.read(statusFile()).catch(() => '')
    }

    const storedVoice = await $.store.get('voice')
    if (typeof storedVoice === 'string' && storedVoice) voice = storedVoice
    // A voice that is not installed here (Zoe is a download) falls back to the system
    // voice: an empty name, which the reader leaves out.
    const installed = (await $.process.run(['say', '-v', '?'])).stdout
    if (voice && !installed.split('\n').some(line => line.startsWith(`${voice} `))) voice = ''
    const storedSpeed = await $.store.get('speed')
    await setSpeed($, typeof storedSpeed === 'number' ? storedSpeed : 1)
    const storedOn = (await $.store.get('isOn')) === true
    const storedConversational = (await $.store.get('isConversational')) === true
    await update($, isConversational, () => storedConversational)
    const storedFollowing = (await $.store.get('isFollowing')) === true
    await update($, isFollowing, () => storedFollowing)
    if (storedFollowing) void $.ui.open({ id: PANE, title: 'Now reading' })
    await update($, isOn, () => storedOn)
    // A reading in flight when the mod reloaded is no longer followed.
    await update($, speaking, () => null)

    $.clock.every(400, () => checkStatus($))

    await $.command.register({
      name: 'read-aloud',
      description:
        'Turn reading aloud on or off (or: status, stop, continue, speed <0.5-3>, voice <name>)',
    })

    await $.command.register({
      name: 'conversational',
      description: 'Turn conversational replies on or off: plain explanations, technical detail kept in the background',
    })

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, isConversational))) return composed
    return { sections: [...composed.sections, CONVERSATIONAL] }
  })

  on('command.run', { command: 'conversational' }, async ($, e) => {
    const arg = String(e.args ?? '').trim()
    const value = arg === 'on' ? true : arg === 'off' ? false : !(await read($, isConversational))
    await setConversational($, value)
    return { text: `Conversational replies ${value ? 'on' : 'off'}, from the next message.` }
  })

  // Closing the pane by hand turns Follow off.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && (await read($, isFollowing))) {
      await update($, isFollowing, () => false)
      await $.store.set('isFollowing', false)
    }
    return next(e)
  })

  // Marks replies in the transcript: the one being read gets a bar down its left side;
  // one not listened to yet (or only partly) gets a label at the top, an end marker at
  // the bottom, and buttons to listen from there or mark it as read; any other gets a
  // quiet footer to listen from there or mark it unread again.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary || !(await read($, isOn))) return next(e)
    const piece = pieceOf(e.props.text)
    if (piece.sentences.length === 0) return next(e)
    const text = piece.sentences.join(' ')
    rowPieces.set(text, piece)
    rowOf.set(text, e.requestId)
    const item = (await read($, pending)).find(byText(text))

    const { Box, Button, Text } = $.ui.resolve(e)
    const row = await next(e)

    // Already heard, marked as read, or from before the queue: a quiet footer to replay
    // it or put it back in the unread queue.
    if (!item) {
      return (
        <Box flexDirection="column">
          {row}
          <Box gap={1}>
            <Button key="replay" label="▶ Listen from here" plain dimColor onPress={() => listenFromRow($, text)} />
            <Button key="unread" label="↺ Mark as unread" plain dimColor onPress={() => markUnread($, text)} />
          </Box>
        </Box>
      )
    }

    if (item.id === (await read($, speaking))) {
      return (
        <Box borderStyle="quote" borderColor="suggestion">
          {row}
        </Box>
      )
    }

    const isPartly = item.progress > 0
    return (
      <Box flexDirection="column" borderStyle="quote" borderColor="warning">
        <Text color="warning">
          {isPartly
            ? `◐ Partly listened (stopped at sentence ${item.progress + 1} of ${item.sentences.length})`
            : '● Not listened to yet'}
        </Text>
        {row}
        <Box gap={1}>
          <Text color="warning">▲ end of unread</Text>
          <Button key="listen" label="▶ Listen from here" onPress={() => listenFrom($, item.id)} />
          <Button key="read" label="✓ Mark as read" onPress={() => markRead($, item.id)} />
        </Box>
      </Box>
    )
  })

  // The Now reading pane: controls on top, then the piece being read (or the next unread
  // one) drawn exactly like the message, block by block: blocks already read greyed out;
  // in the one being read the sentence being read in the link colour (a click restarts
  // it); a ▶ under the pointer on any other block starts reading there;
  // finished blocks dimmed, code shown but never read.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const id = await read($, speaking)
    const queue = await read($, pending)
    const item = queue.find(one => one.id === id) ?? queue[0]
    const isLive = item !== undefined && item.id === id
    const current = await read($, speed)
    const slower = SPEEDS.filter(s => s < current).at(-1)
    const faster = SPEEDS.find(s => s > current)

    const controls = (
      <Box gap={1}>
        {isLive ? (
          <Button key="pane-stop" label="■ Stop" onPress={() => stopSpeech($)} />
        ) : (
          <Button
            key="pane-play"
            label={item && item.progress > 0 ? '▶ Continue' : '▶ Play'}
            variant="primary"
            onPress={() => (item ? listenFrom($, item.id) : undefined)}
          />
        )}
        <Button key="pane-slower" label="−" onPress={() => (slower ? setSpeed($, slower) : undefined)} />
        <Box minWidth={5} justifyContent="center">
          <Text dimColor>{current.toFixed(1)}×</Text>
        </Box>
        <Button key="pane-faster" label="+" onPress={() => (faster ? setSpeed($, faster) : undefined)} />
        {queue.length > 1 && <Text dimColor>{queue.length - (isLive ? 1 : 0)} more unread</Text>}
      </Box>
    )

    if (!item) {
      return (
        <Box flexDirection="column" gap={1}>
          {controls}
          <Text dimColor>Nothing left to read.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {controls}
        {!isLive && <Text dimColor>Paused. Press Continue, or hover a paragraph and press ▶ to start there.</Text>}
        {blocksOfPiece(item).map((block, n) => {
          const isSpoken = block.to > block.from
          const isCurrent = item.progress >= block.from && item.progress < block.to
          const isDone = isSpoken && block.to <= item.progress
          return (
            // A strip is always kept free on the right for the ▶ button a hover reveals,
            // so it covers nothing and nothing moves.
            <Box key={`b-${n}`} position="relative" paddingRight={6}>
              <Markdown
                key={`md-${n}`}
                text={isCurrent ? withSentenceLinks(block.markdown, block, item.sentences, item.progress) : block.markdown}
                dimColor={isDone}
                onLinkPress={link => {
                  const index = Number(link.href.slice(SENTENCE_LINK.length))
                  return Number.isInteger(index) ? listenFrom($, item.id, index) : undefined
                }}
              />
              {isSpoken && !isCurrent && (
                <Box position="absolute" right={0} top={0} display="none" hover={{ display: 'flex' }}>
                  <Button key={`from-${n}`} label="▶" variant="primary" onPress={() => listenFrom($, item.id, block.from)} />
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    await claimActive($)
    return next(e)
  })

  on('command.run', { command: 'read-aloud' }, async ($, e) => {
    const arg = String(e.args ?? '').trim()

    if (arg === 'stop') {
      await stopSpeech($)
      return { text: 'Stopped.' }
    }

    if (arg === 'voice' || arg.startsWith('voice ')) {
      const name = arg.slice(5).trim()
      if (!name) return { text: `Voice: ${voice || 'the system voice'}. List voices in a terminal with: say -v '?'` }
      const list = (await $.process.run(['say', '-v', '?'])).stdout
      const isInstalled = list.split('\n').some(line => line.startsWith(`${name} `))
      if (!isInstalled) return { text: `No voice named "${name}" is installed.` }
      voice = name
      await $.store.set('voice', name)
      await update($, mode, () => null)
      await speak($, { id: 'sample', seq: 0, sentences: [`This is ${name}.`], progress: 0 })
      return { text: `Voice set to ${name}.` }
    }

    if (arg === 'speed' || arg.startsWith('speed ')) {
      const value = Number(arg.slice(5).trim())
      if (!value) return { text: `Speed: ${await read($, speed)}×.` }
      if (value < 0.5 || value > 3) return { text: 'Pick a speed from 0.5 to 3.' }
      await setSpeed($, value)
      return { text: `Speed set to ${value}×, from the next sentence.` }
    }

    await claimActive($)

    if (arg === 'continue' || arg === 'catchup') {
      const count = (await read($, pending)).length
      if (count === 0) return { text: 'Nothing left to read.' }
      await continueReading($)
      return { text: `Reading ${count} unread ${count === 1 ? 'piece' : 'pieces'}.` }
    }

    if (arg === 'status') {
      return {
        text: `Read aloud is ${(await read($, isOn)) ? 'on' : 'off'}, ${await read($, speed)}× speed, ${(await read($, pending)).length} unread; this is now the session that speaks.`,
      }
    }

    const value = arg === 'on' ? true : arg === 'off' ? false : !(await read($, isOn))
    await setOn($, value)

    return { text: `Read aloud ${value ? 'on' : 'off'}.` }
  })

  // Each model response of the main conversation, as soon as it is complete: the text
  // written between steps is read while the work goes on, and the final reply is the
  // last step's text, so nothing is read twice.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined) await arrive($, `${e.turnId}:${e.index}`, result.answer)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const isOnNow = await read($, isOn)
    const isChatty = await read($, isConversational)
    const isFollowingNow = await read($, isFollowing)
    const isSpeaking = (await read($, speaking)) !== null
    const queue = await read($, pending)
    const current = await read($, speed)
    const slower = SPEEDS.filter(s => s < current).at(-1)
    const faster = SPEEDS.find(s => s > current)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box gap={1}>
        <Button
          key="toggle"
          label={isOnNow ? '🔊 Read aloud: on' : '🔈 Read aloud: off'}
          onPress={async () => {
            await claimActive($)
            await setOn($, !isOnNow)
          }}
        />
        <Button
          key="conversational"
          label={isChatty ? '💬 Conversational: on' : '💬 Conversational: off'}
          onPress={() => setConversational($, !isChatty)}
        />
        {isOnNow && (
          <Button key="slower" label="−" onPress={() => (slower ? setSpeed($, slower) : undefined)} />
        )}
        {isOnNow && (
          // Fixed width and always one decimal, so the + button never moves under the pointer.
          <Box minWidth={5} justifyContent="center">
            <Text dimColor>{current.toFixed(1)}×</Text>
          </Box>
        )}
        {isOnNow && (
          <Button key="faster" label="+" onPress={() => (faster ? setSpeed($, faster) : undefined)} />
        )}
        {isOnNow && isSpeaking && <Button key="stop" label="■ Stop" onPress={() => stopSpeech($)} />}
        {/* Only the terminal lets a mod scroll the chat; the desktop app refuses. */}
        {isOnNow && isSpeaking && e.surface === 'terminal' && (
          <Button key="jump" label="↧ Jump to it" onPress={() => jumpToCurrent($)} />
        )}
        {isOnNow && (
          <Button
            key="follow"
            label={isFollowingNow ? '📖 Follow: on' : '📖 Follow: off'}
            onPress={() => setFollowing($, !isFollowingNow)}
          />
        )}
        {isOnNow && !isSpeaking && queue.length > 0 && (
          <Button
            key="continue"
            label={`▶ Continue (${queue.length} unread)`}
            onPress={() => continueReading($)}
          />
        )}
      </Box>
    )
  })
}
