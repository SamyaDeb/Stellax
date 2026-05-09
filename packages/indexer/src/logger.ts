import pino, { type Logger } from "pino";

const root = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV === "production"
    ? undefined
    : {
        target: "pino/file",
        options: { destination: 1 }, // stdout
      },
});

export function getLogger(name: string): Logger {
  return root.child({ mod: name });
}
