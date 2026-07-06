import { Mastra } from "@mastra/core";
import { pgStore, memory } from "./memory";

import { supervisorAgent } from "./agents/supervisor";
import { researchAgent } from "./agents/research";
import { documentAgent } from "./agents/document";
import { writerAgent } from "./agents/writer";

// Mastra Instance
export const mastra = new Mastra({
  storage: pgStore,
  agents: { supervisorAgent, researchAgent, documentAgent, writerAgent },
});

export { supervisorAgent, researchAgent, documentAgent, writerAgent, memory };

console.log("✓ Mastra initialized with PostgreSQL + Memory system");
