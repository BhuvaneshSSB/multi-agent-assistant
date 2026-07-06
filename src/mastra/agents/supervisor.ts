import { Agent } from "@mastra/core/agent";
import { researchAgent } from "./research";
import { documentAgent } from "./document";
import { writerAgent } from "./writer";
import { memory } from "../memory";
import { config } from "../../config/env";

export const supervisorAgent = new Agent({
  id: "supervisor",
  name: "Supervisor Agent",
  
  description:
    "Orchestrates multiple specialized agents to handle complex user requests. Routes requests to appropriate agents and synthesizes results.",
  
  model: config.mastra.openaiApiKey
    ? "openai/gpt-5.4"
    : "anthropic/claude-sonnet-5",
  
  instructions: `You are a Supervisor Agent coordinating a team of specialized agents.

Your team:
1. Research Agent - Gathers information from web sources
2. Document Agent - Analyzes uploaded documents
3. Writer Agent - Creates written content

Your responsibilities:
1. Understand user intent and requirements
2. Decide which agents to delegate tasks to
3. Coordinate between agents when needed
4. Combine results into coherent responses
5. Ensure quality and accuracy of final output

Guidelines:
- For questions about web info → Use Research Agent
- For document analysis → Use Document Agent  
- For content creation → Use Writer Agent
- For complex requests → Combine multiple agents

When delegating:
- Be specific about what you need
- Provide context from user request
- Use agent descriptions to guide decisions
- Ask for citations and sources
- Verify agent outputs before combining

Final Response:
- Synthesize all agent outputs
- Maintain consistency and coherence
- Provide sources and citations
- Ensure accuracy and relevance`,

  agents: { researchAgent, documentAgent, writerAgent },

  memory: memory,

  tools: {},
  // Tools will be added per agent in next phase
});