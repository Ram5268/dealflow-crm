import pino from 'pino'

// Configured pino instance. Pretty, human-readable output in dev; structured
// JSON in production (for log aggregation). Level via LOG_LEVEL, default info.
const isDev = process.env.NODE_ENV !== 'production'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }
    : {}),
})

export default logger
