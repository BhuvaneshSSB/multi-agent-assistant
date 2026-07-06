import { PinoLogger } from "@mastra/loggers";

export const logger = new PinoLogger({
  name: "multi-agent-assistant",
  level: "info",
});
