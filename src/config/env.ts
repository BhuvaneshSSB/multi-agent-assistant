import dotenv from "dotenv";

dotenv.config();

export const config = {
  database: {
    url: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/multi_agent",
  },
  api: {
    port: parseInt(process.env.API_PORT || "3000", 10),
  },
  mastra: {
    openaiApiKey: process.env.OPENAI_API_KEY,
  },
  search: {
    newsApiKey: process.env.NEWS_API_KEY,
  },
  environment: process.env.NODE_ENV || "development",
};