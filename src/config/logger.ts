import { createRequire } from "node:module";
import type { IncomingMessage } from "node:http";
import type { DestinationStream, Logger, LoggerOptions } from "pino";
import { config } from "./env.js";

const require = createRequire(import.meta.url);

const pino = require("pino") as (
  optionsOrStream?: LoggerOptions | DestinationStream,
  destination?: DestinationStream,
) => Logger;

type PinoHttpFactory = (opts?: {
  logger?: Logger;
  autoLogging?: boolean | { ignore?: (req: IncomingMessage) => boolean };
}) => (req: IncomingMessage, res: unknown, next?: () => void) => void;

const pinoHttp = require("pino-http") as PinoHttpFactory;

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      "password",
      "req.headers.authorization",
      'req.headers["x-api-key"]',
      "req.headers.cookie",
      "account_number",
      "access_token",
      "apiKey",
      "DATABASE_URL",
      "*.password",
      "*.access_token",
      "*.authorization",
    ],
    remove: true,
  },
  ...(config.nodeEnv === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard" },
        },
      }
    : {}),
});

export { pinoHttp };
