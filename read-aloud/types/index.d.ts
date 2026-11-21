/** A piece of Claude's text in this session that has not been read aloud to the end yet. */
export type Pending = {
  id: string
  seq: number
  sentences: string[]
  /** The sentence to start from: the one cut off, or 0 when never read. */
  progress: number
  /** The sentences that open a new line or paragraph, for drawing it like the chat. */
  lineStarts?: number[]
  /** The original message in blocks (paragraph, list item, code, table), each with its
   *  sentence range [from, to); a code block has none and is never read. */
  blocks?: Block[]
}

export type Block = { markdown: string; from: number; to: number }

/** live: reading new text as it arrives; catchup: working through the backlog. */
export type PlayMode = 'live' | 'catchup' | null

declare module 'claude-code' {
  interface PluginState {
    'read-aloud': {
      isOn: boolean
      /** This session's unread text, oldest first. */
      pending: Shaped<Pending[]>
      /** Replies already listened to or marked as read, oldest first (kept to mark unread again). */
      history: Shaped<Pending[]>
      /** Reading speed as a multiple of the normal rate. */
      speed: number
      /** The id being read right now, or null. */
      speaking: string | null
      mode: PlayMode
      /** Whether Claude is asked to write replies as plain, explanatory speech. */
      isConversational: boolean
      /** Whether the Now reading pane follows along beside the chat. */
      isFollowing: boolean
    }
  }
}
