import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { combinedSearch, formatSearchResultsForLLM } from "../tools/web-search";
import { config } from "../../config/env";

const webSearchTool = createTool({
  id: "web-search",
  description: "Search the web using multiple sources (DuckDuckGo, Wikipedia, NewsAPI) and get results with citations",
  inputSchema: z.object({
    query: z.string().describe("The search query to find information about"),
  }),
  execute: async ({ query }) => {
    try {
      const results = await combinedSearch(query);
      const formatted = formatSearchResultsForLLM(results);
      return {
        success: true,
        data: formatted,
        resultCount: results.length,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Search failed",
      };
    }
  },
});

export const researchAgent = new Agent({
  id: "research-agent",
  name: "Research Agent",

  description:
    "Gathers information from web sources using web search. Performs searches on DuckDuckGo, Wikipedia, and News API, synthesizes findings with citations.",

  model: "openai/gpt-4o-mini",

  instructions: `You are a Research Agent specializing in gathering accurate information from web sources.

Your responsibilities:
1. Search for information using available search tools
2. Evaluate source credibility and relevance
3. Synthesize findings into clear, structured insights
4. Always provide citations with sources and URLs
5. Note publication dates for news and time-sensitive info

When presenting information:
- Start with a brief summary
- Provide detailed findings organized by topic
- Include proper citations with clickable links
- Note the source type (Web Search, Wikipedia, News)
- Highlight any conflicting information
- Mention if information is recent or older

Citation Format:
- Use markdown links: [Title](URL)
- Include source and date for news articles
- Reference specific sections for Wikipedia

Always be honest about:
- Information freshness
- Source reliability
- Any gaps in available information
- Need for additional searches

If repeated searches (including reworded queries) keep returning irrelevant or empty results,
stop retrying and say so explicitly — e.g. "I searched for X but the available sources didn't
return reliable, relevant results" — rather than giving up silently. Never end your turn with an
empty or near-empty response; if you truly found nothing useful, that finding itself is the
answer to report.`,

  tools: {
    "web-search": webSearchTool,
  },
});