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
    // Default model is google/gemini-2.5-flash, but only OPENAI_API_KEY is
    // configured in this project — route both the Observer and Reflector
    // agents through OpenAI instead.
    observationalMemory: {
      model: "openai/gpt-4o-mini",
    },

    // Layer 3: Working Memory
    // scope: "thread" isolates working memory per conversationId rather than
    // the library default of "resource" (per userId) — the rest of the app
    // (document storage, retrieval-gate) already treats conversationId as
    // the isolation boundary; leaving this at the resource-scoped default
    // leaked document summaries/findings across a user's unrelated
    // conversations.
    workingMemory: {
      enabled: true,
      scope: "thread",
      template: `# User Context
- Name:
- Preferences:
- Current Task:
- Domain Knowledge:`,
    },

    // Layer 4: Semantic Recall
    // Same thread-scoping rationale as workingMemory above — replaces the
    // `true` shorthand so scope can be set explicitly; topK/messageRange
    // preserve the library's previous implicit defaults.
    semanticRecall: {
      scope: "thread",
      topK: 4,
      messageRange: { before: 1, after: 1 },
    },
  },
});
