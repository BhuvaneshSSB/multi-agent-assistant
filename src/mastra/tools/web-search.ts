import axios from "axios";
import { config } from "../../config/env";
import { withRetry, isRetryableHttpError } from "../../utils/retry";

// ============================================================================
// DUCKDUCKGO SEARCH (General Web Search - No API Key Needed)
// ============================================================================

interface DuckDuckGoResult {
  title: string;
  url: string;
  snippet: string;
}

export async function searchDuckDuckGo(query: string): Promise<DuckDuckGoResult[]> {
  try {
    console.log(`[DuckDuckGo] Searching: ${query}`);

    const response = await withRetry(
      () =>
        axios.get("https://api.duckduckgo.com/", {
          params: {
            q: query,
            format: "json",
            no_redirect: 1,
            no_html: 1,
            skip_disambig: 1,
          },
        }),
      { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 4000, isRetryable: isRetryableHttpError, label: "DuckDuckGo search" }
    );

    const results: DuckDuckGoResult[] = [];

    // Get results from AbstractResults (main answer)
    if (response.data.AbstractURL && response.data.AbstractText) {
      results.push({
        title: response.data.Heading || query,
        url: response.data.AbstractURL,
        snippet: response.data.AbstractText,
      });
    }

    // Get results from RelatedTopics
    if (response.data.RelatedTopics && response.data.RelatedTopics.length > 0) {
      for (const topic of response.data.RelatedTopics.slice(0, 5)) {
        if (topic.FirstURL && topic.Text) {
          results.push({
            title: topic.Text.split(" - ")[0] || query,
            url: topic.FirstURL,
            snippet: topic.Text.split(" - ")[1] || topic.Text,
          });
        }
      }
    }

    console.log(`[DuckDuckGo] Found ${results.length} results`);
    return results;
  } catch (error) {
    console.error("[DuckDuckGo] Error:", error);
    return [];
  }
}

// ============================================================================
// WIKIPEDIA SEARCH (Knowledge Base - No API Key Needed)
// ============================================================================

interface WikipediaResult {
  title: string;
  url: string;
  snippet: string;
}

export async function searchWikipedia(query: string): Promise<WikipediaResult[]> {
  try {
    console.log(`[Wikipedia] Searching: ${query}`);

    // Search Wikipedia
    const searchResponse = await withRetry(
      () =>
        axios.get("https://en.wikipedia.org/w/api.php", {
          params: {
            action: "query",
            list: "search",
            srsearch: query,
            format: "json",
            srlimit: 5,
          },
        }),
      { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 4000, isRetryable: isRetryableHttpError, label: "Wikipedia search" }
    );

    const results: WikipediaResult[] = [];

    if (searchResponse.data.query.search.length === 0) {
      console.log("[Wikipedia] No results found");
      return results;
    }

    // Get full content for each result
    for (const item of searchResponse.data.query.search.slice(0, 3)) {
      try {
        const pageResponse = await withRetry(
          () =>
            axios.get("https://en.wikipedia.org/w/api.php", {
              params: {
                action: "query",
                titles: item.title,
                prop: "extracts",
                explaintext: true,
                format: "json",
                exintro: true,
              },
            }),
          { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 4000, isRetryable: isRetryableHttpError, label: `Wikipedia page fetch (${item.title})` }
        );

        const pages = pageResponse.data.query.pages;
        const pageId = Object.keys(pages)[0];
        const page = pages[pageId];

        if (page.extract) {
          const snippet = page.extract.substring(0, 300) + "...";
          const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title)}`;

          results.push({
            title: item.title,
            url: url,
            snippet: snippet,
          });
        }
      } catch (pageError) {
        console.error(`[Wikipedia] Error fetching page ${item.title}:`, pageError);
      }
    }

    console.log(`[Wikipedia] Found ${results.length} results`);
    return results;
  } catch (error) {
    console.error("[Wikipedia] Error:", error);
    return [];
  }
}

// ============================================================================
// NEWS API SEARCH (Latest News - Requires API Key)
// ============================================================================

interface NewsResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedAt: string;
}

export async function searchNews(query: string): Promise<NewsResult[]> {
  try {
    if (!config.search.newsApiKey) {
      console.warn("[NewsAPI] API key not configured, skipping news search");
      return [];
    }

    console.log(`[NewsAPI] Searching: ${query}`);

    const response = await withRetry(
      () =>
        axios.get("https://newsapi.org/v2/everything", {
          params: {
            q: query,
            sortBy: "publishedAt",
            language: "en",
            pageSize: 5,
            apiKey: config.search.newsApiKey,
          },
        }),
      { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 4000, isRetryable: isRetryableHttpError, label: "NewsAPI search" }
    );

    const results: NewsResult[] = [];

    if (!response.data.articles || response.data.articles.length === 0) {
      console.log("[NewsAPI] No articles found");
      return results;
    }

    for (const article of response.data.articles) {
      results.push({
        title: article.title,
        url: article.url,
        snippet: article.description || article.content || "No description available",
        source: article.source.name,
        publishedAt: new Date(article.publishedAt).toLocaleDateString(),
      });
    }

    console.log(`[NewsAPI] Found ${results.length} articles`);
    return results;
  } catch (error) {
    console.error("[NewsAPI] Error:", error);
    return [];
  }
}

// ============================================================================
// COMBINED SEARCH (Research Agent Uses This)
// ============================================================================

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: "DuckDuckGo" | "Wikipedia" | "NewsAPI";
  date?: string;
}

export async function combinedSearch(query: string): Promise<SearchResult[]> {
  console.log(`[CombinedSearch] Searching for: ${query}`);

  try {
    // Run all searches in parallel
    const [ddgResults, wikiResults, newsResults] = await Promise.all([
      searchDuckDuckGo(query),
      searchWikipedia(query),
      searchNews(query),
    ]);

    const results: SearchResult[] = [];

    // Add DuckDuckGo results
    for (const result of ddgResults) {
      results.push({
        ...result,
        source: "DuckDuckGo",
      });
    }

    // Add Wikipedia results
    for (const result of wikiResults) {
      results.push({
        ...result,
        source: "Wikipedia",
      });
    }

    // Add News results
    for (const result of newsResults) {
      results.push({
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        source: "NewsAPI",
        date: result.publishedAt,
      });
    }

    console.log(`[CombinedSearch] Total results: ${results.length}`);
    return results;
  } catch (error) {
    console.error("[CombinedSearch] Error:", error);
    return [];
  }
}

// ============================================================================
// FORMAT RESULTS FOR LLM WITH CITATIONS
// ============================================================================

export function formatSearchResultsForLLM(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No search results found.";
  }

  let formatted = "## Search Results with Citations\n\n";

  // Group by source
  const bySource = {
    DuckDuckGo: results.filter((r) => r.source === "DuckDuckGo"),
    Wikipedia: results.filter((r) => r.source === "Wikipedia"),
    NewsAPI: results.filter((r) => r.source === "NewsAPI"),
  };

  // Format DuckDuckGo results
  if (bySource.DuckDuckGo.length > 0) {
    formatted += "### General Information (Web Search)\n\n";
    for (let i = 0; i < bySource.DuckDuckGo.length; i++) {
      const result = bySource.DuckDuckGo[i];
      formatted += `**[${result.title}](${result.url})**\n`;
      formatted += `${result.snippet}\n\n`;
    }
  }

  // Format Wikipedia results
  if (bySource.Wikipedia.length > 0) {
    formatted += "### Wikipedia References\n\n";
    for (const result of bySource.Wikipedia) {
      formatted += `**[${result.title}](${result.url})**\n`;
      formatted += `${result.snippet}\n\n`;
    }
  }

  // Format News results
  if (bySource.NewsAPI.length > 0) {
    formatted += "### Latest News\n\n";
    for (const result of bySource.NewsAPI) {
      formatted += `**[${result.title}](${result.url})** - *${result.source} (${result.date})*\n`;
      formatted += `${result.snippet}\n\n`;
    }
  }

  return formatted;
}