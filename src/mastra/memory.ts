import { PostgresStore, PgVector } from "@mastra/pg";
import { Memory } from "@mastra/memory";
import { ModelRouterEmbeddingModel } from "@mastra/core/llm";
import { config } from "../config/env";

// PostgreSQL Storage
export const pgStore = new PostgresStore({
  id: "mastra-storage",
  connectionString: config.database.url,
});

// PostgreSQL Vector Store (for semantic recall)
const pgVector = new PgVector({
  id: "mastra-vector",
  connectionString: config.database.url,
});

// Embedder (OpenAI embeddings for semantic recall)
const embedder = new ModelRouterEmbeddingModel({
  id: "openai/text-embedding-3-small",
  apiKey: config.mastra.openaiApiKey,
});

// Memory System - 4 Layers Built-In
export const memory = new Memory({
  storage: pgStore,
  vector: pgVector,
  embedder: embedder,
  options: {
    // Layer 1: Message History
    lastMessages: 10,

    // Layer 2: Observational Memory
    observationalMemory: true,

    // Layer 3: Working Memory
    workingMemory: {
      enabled: true,
      template: `# User Context
- Name:
- Preferences:
- Current Task:
- Domain Knowledge:`,
    },

    // Layer 4: Semantic Recall
    semanticRecall: true,
  },
});
