import { Mastra } from "@mastra/core";
import { Observability, MastraStorageExporter } from "@mastra/observability";
import { pgStore, memory } from "./memory";

import { supervisorAgent } from "./agents/supervisor";
import { researchAgent } from "./agents/research";
import { documentAgent } from "./agents/document";
import { writerAgent } from "./agents/writer";

import { allWritingSkills } from "./skills/writing-skills";

import { documentIngestionWorkflow } from "./workflows/document-ingestion";
// Mastra Instance
export const mastra = new Mastra({
  storage: pgStore,
  agents: { supervisorAgent, researchAgent, documentAgent, writerAgent },
  workflows: { documentIngestionWorkflow },
  observability: new Observability({
    configs: {
      default: {
        serviceName: "multi-agent-assistant",
        // ConsoleExporter previously logged every span's full input/output via
        // JSON.stringify(..., null, 2), unconditionally (not gated by logLevel,
        // which only sets a threshold — these dumps are hardcoded at .info()).
        // For document ingestion, spans carry entire chunk arrays with full
        // text, re-serialized and printed at every step boundary — this was
        // adding ~10-15s of synchronous JSON/console overhead per step, which
        // is what made ingestion look like it was taking 2 minutes when the
        // actual parse/chunk/embed work took ~7s. Traces are still persisted
        // via MastraStorageExporter (batched, not on the hot path).
        exporters: [new MastraStorageExporter()],
      },
    },
  }),
});

export { supervisorAgent, researchAgent, documentAgent, writerAgent, memory };

export { documentIngestionWorkflow };

export { allWritingSkills };

console.log("✓ Mastra initialized with PostgreSQL + Memory system");
