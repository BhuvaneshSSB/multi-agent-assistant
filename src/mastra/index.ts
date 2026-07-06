import { Mastra } from "@mastra/core";
import { Observability, ConsoleExporter, MastraStorageExporter } from "@mastra/observability";
import { pgStore, memory } from "./memory";

import { supervisorAgent } from "./agents/supervisor";
import { researchAgent } from "./agents/research";
import { documentAgent } from "./agents/document";
import { writerAgent } from "./agents/writer";

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
        exporters: [new ConsoleExporter({ logLevel: "debug" }), new MastraStorageExporter()],
        // Scoped to the Document Agent for now; widen once verified.
        spanFilter: (span) => span.entityId === documentAgent.id,
      },
    },
  }),
});

export { supervisorAgent, researchAgent, documentAgent, writerAgent, memory };

export { documentIngestionWorkflow };

console.log("✓ Mastra initialized with PostgreSQL + Memory system");
