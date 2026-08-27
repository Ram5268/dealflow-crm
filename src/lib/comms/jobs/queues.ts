/** pg-boss queue names for the Communications slice (brief §pg-boss). */
export const QUEUES = {
  SEND_EMAIL: 'send-email',
  SEND_SMS: 'send-sms',
  GMAIL_DELTA_SYNC: 'gmail-delta-sync',
  GRAPH_DELTA_SYNC: 'graph-delta-sync',
  GMAIL_RENEW_WATCH: 'gmail-renew-watch',
  RECONCILE_THREADS: 'reconcile-threads',
  SMS_STOP_RELAY: 'sms-stop-relay',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

export const ALL_QUEUES: QueueName[] = Object.values(QUEUES)
