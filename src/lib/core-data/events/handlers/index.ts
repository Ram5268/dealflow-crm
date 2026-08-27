import type { DemuxHandlers } from '../demux'
import { onCallConnected } from './call-connected'
import { onCallCompleted } from './call-completed'
import { onMessageReceived } from './message-received'
import { onScrubCompleted, onPacingUpdate } from './scrub-completed'

// The production handler set wired to real prisma-backed reactions.
export const HANDLERS: DemuxHandlers = {
  'call.connected': onCallConnected,
  'call.completed': onCallCompleted,
  'dial-session.pacing-update': onPacingUpdate,
  'message.received': onMessageReceived,
  'scrub.completed': onScrubCompleted,
}
