import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { allWritingSkills } from "../skills/writing-skills";
import { config } from "../../config/env";
import { logger } from "../../utils/logger";

const generateContentTool = createTool({
  id: "generate-content",
  description:
    "Activate the writing skill matching the requested content type and return its instructions to follow when generating content.",
  inputSchema: z.object({
    contentType: z
      .string()
      .describe(
        `Content type / skill name to activate. One of: ${allWritingSkills
          .map((skill) => skill.name)
          .join(", ")}`
      ),
    topic: z.string().describe("Main topic or subject for the content"),
    tone: z
      .enum(["professional", "casual", "technical", "creative", "friendly"])
      .default("professional")
      .describe("Desired tone of writing"),
    length: z
      .enum(["short", "medium", "long"])
      .default("medium")
      .describe("Desired length of content"),
    additionalInstructions: z
      .string()
      .optional()
      .describe("Any additional requirements or preferences"),
    context: z
      .string()
      .optional()
      .describe(
        "Optional context from other agents (research findings, document excerpts, etc.)"
      ),
  }),
  execute: async ({
    contentType,
    topic,
    tone,
    length,
    additionalInstructions,
    context,
  }) => {
    try {
      const skill = allWritingSkills.find((s) => s.name === contentType);

      if (!skill) {
        return {
          success: false,
          error: `No writing skill found for contentType "${contentType}". Available: ${allWritingSkills
            .map((s) => s.name)
            .join(", ")}`,
        };
      }

      logger.info("[WriterAgent] Activated writing skill", {
        skill: skill.name,
        topic: topic.substring(0, 50),
      });

      return {
        success: true,
        skill: skill.name,
        instructions: skill.instructions,
        topic,
        tone,
        length,
        additionalInstructions,
        context,
      };
    } catch (error) {
      logger.error("[WriterAgent] Skill activation failed", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Skill activation failed",
      };
    }
  },
});

export const writerAgent = new Agent({
  id: "writer-agent",
  name: "Writer Agent",

  description:
    "Generates high-quality written content in multiple formats. Uses specialized writing skills for blogs, emails, social media, marketing copy, documentation, and more.",

  model: "openai/gpt-4o-mini",

  instructions: `You are a professional content writer and editor specializing in multiple writing formats.

You have access to specialized writing skills for different content types:
- Blog posts and articles
- Professional emails and newsletters
- Social media content (LinkedIn, Twitter, Instagram)
- Marketing copy and sales materials
- Press releases
- Technical documentation
- Reports, guides, and tutorials

Your approach:
1. Understand the user's request and desired content type
2. Search your available skills to find the best match
3. Use the appropriate skill to generate content
4. Ensure output meets the skill's requirements
5. Deliver polished, ready-to-use content

For any content request:
- Ask clarifying questions if needed
- Select the most appropriate skill
- Generate content following skill instructions
- Provide brief context about what was generated
- Offer to refine or create variations`,

  skills: allWritingSkills,

  tools: {
    "generate-content": generateContentTool,
  },
});