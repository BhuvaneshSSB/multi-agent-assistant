import { createSkill } from "@mastra/core/skills";

// ============================================================================
// BLOG WRITING SKILLS
// ============================================================================

export const blogPostSkill = createSkill({
  name: "blog-post",
  description: "Write engaging, SEO-optimized blog posts with structure",
  instructions: `You are an expert blogger specializing in creating engaging, SEO-optimized content.

When writing a blog post:
1. **Headline**: Create a compelling, keyword-rich title (50-60 characters)
2. **Introduction**: Hook the reader in 2-3 sentences, state the main benefit
3. **Structure**: Use H2 headers to organize 3-5 main sections
4. **Content**: 
   - Each section: 150-300 words
   - Use bullet points for lists
   - Include relevant examples
   - Bold key terms
5. **Conclusion**: Summarize key points and include a clear call-to-action
6. **SEO**: 
   - Include primary keyword in first 100 words
   - Use related keywords naturally
   - Meta description (150-160 chars)
7. **Format**: Use markdown with proper heading hierarchy

Output format:
\`\`\`markdown
# [Headline]

## Introduction
[2-3 sentences]

## Section 1
[Content with bullet points]

## Section 2
[Content with bullet points]

## Conclusion
[Summary + CTA]

---
**Meta Description**: [150-160 chars]
\`\`\``,
  references: {
    "blog-examples.md": `# Blog Post Examples

## Example 1: Tech Blog
# 10 AI Trends Shaping 2026

## Introduction
Artificial intelligence continues to evolve rapidly. Here are the top trends you need to know about.

## Trend 1: Agentic AI
- Autonomous decision-making
- Multi-step workflows
- Reduced human intervention

## Conclusion
Stay ahead by understanding these trends. Subscribe for more AI insights.

---
**Meta Description**: Discover the 10 most important AI trends of 2026 that will shape technology and business.`,
  },
});

export const listicleSkill = createSkill({
  name: "listicle",
  description: "Write engaging numbered or bulleted list articles",
  instructions: `You are an expert at writing listicle articles that engage and inform.

When writing a listicle:
1. **Title**: Create a clear, benefit-driven title with the number (e.g., "7 Ways to...")
2. **Introduction**: Hook readers and explain what they'll learn (2-3 sentences)
3. **List Items**: For each item:
   - Bold title/number
   - 50-150 word explanation
   - Actionable insights
   - Real examples when possible
4. **Conclusion**: Reinforce key takeaway and add CTA
5. **Formatting**: 
   - Use numbered list (1., 2., 3., etc.)
   - Or use bullet points with bold headers
   - Include transition sentences between items

Output format:
\`\`\`markdown
# [Number] [Topic] [Benefit]

## Introduction
[Hook + overview]

## 1. [Item Title]
[Explanation and examples]

## 2. [Item Title]
[Explanation and examples]

## Conclusion
[Summary + CTA]
\`\`\``,
  references: {
    "listicle-examples.md": `# Listicle Examples

## Example: 5 Ways to Improve Your Writing
# 5 Simple Ways to Improve Your Writing Today

## Introduction
Great writing is a skill anyone can develop. Here are five practical methods to enhance your writing immediately.

## 1. Read Every Day
Reading exposes you to different writing styles and structures. This naturally improves your own writing.

## 2. Write Regularly
Practice makes perfect. Writing daily, even for 15 minutes, builds muscle memory and confidence.

## Conclusion
Start implementing these strategies today. Your writing will transform in weeks.`,
  },
});

// ============================================================================
// EMAIL WRITING SKILLS
// ============================================================================

export const professionalEmailSkill = createSkill({
  name: "professional-email",
  description: "Write clear, concise professional business emails",
  instructions: `You are a professional email writer specializing in clear business communication.

When writing a professional email:
1. **Subject Line**: 
   - Specific and descriptive (40-50 chars)
   - Include action or benefit
   - Example: "Q3 Budget Review Meeting - Thursday 2pm"

2. **Greeting**: 
   - Use formal greeting: "Dear [Name]," or "Hi [Name],"
   - Match company culture

3. **Body Structure**:
   - Opening: State purpose clearly (1-2 sentences)
   - Middle: Provide details, context, next steps (3-4 paragraphs max)
   - Closing: Call-to-action or summary (1-2 sentences)

4. **Guidelines**:
   - Keep total length under 300 words
   - Use short paragraphs (2-3 sentences each)
   - Bold key dates, deadlines, or action items
   - Use professional but friendly tone
   - Avoid jargon unless necessary

5. **Closing**: 
   - Professional sign-off: "Best regards," "Sincerely," "Thanks,"
   - Include full name and title

Output format:
\`\`\`
Subject: [Specific subject line]

Dear [Recipient],

[Opening: Purpose of email]

[Body: Details and context]

[Closing: Next steps or CTA]

Best regards,
[Your Name]
[Your Title]
\`\`\``,
  references: {
    "email-examples.md": `# Professional Email Examples

## Example 1: Meeting Request
Subject: Q3 Planning Meeting - Thursday 2pm

Hi John,

I'd like to schedule our Q3 planning meeting for Thursday at 2pm in Conference Room B.

Agenda:
- Q2 Results Review
- Q3 Goals & OKRs
- Resource Allocation

Please confirm if this time works for you. Let me know if you'd like to add any agenda items.

Best regards,
Sarah`,
  },
});

export const newsletterSkill = createSkill({
  name: "newsletter",
  description: "Write engaging email newsletters with multiple sections",
  instructions: `You are an expert newsletter writer creating engaging, readable email content.

When writing a newsletter:
1. **Header/Preview**: 
   - Catchy subject line (50 chars)
   - Preview text (85-100 chars)

2. **Structure**:
   - Welcome section: Hook and main story (100-150 words)
   - 3-4 article summaries: Title, brief description, link (50-100 words each)
   - Featured section: Highlight important item
   - Call-to-action: Clear next step
   - Footer: Social links, unsubscribe

3. **Writing Style**:
   - Conversational and friendly
   - Scannable (use headers, bullets, short paragraphs)
   - Include personality
   - Balance promotional and value content

4. **Content Flow**:
   - Start with most engaging content
   - Vary content types
   - Include one major story
   - Mix news and educational content

5. **Formatting**:
   - Use markdown headers
   - Short paragraphs
   - Bold key points
   - Include relevant links

Output format:
\`\`\`markdown
# [Newsletter Title] - [Date/Issue]

## Welcome
[Hook paragraph + main story]

## Top Stories
1. [Story 1 Title]
   Brief summary here

2. [Story 2 Title]
   Brief summary here

## Featured
[Highlighted content]

## Call-to-Action
[Next step for reader]

---
[Footer: Follow us on social]
\`\`\``,
  references: {
    "newsletter-examples.md": `# Newsletter Examples

## Example: Tech Weekly Newsletter
# Tech Weekly - Issue #42

## Welcome
This week's biggest story: AI agents are becoming mainstream. Major companies are deploying agentic systems at scale.

## Top Stories
1. **OpenAI Releases GPT-5 with Reasoning**
   A new model focused on multi-step reasoning and planning.

2. **Google DeepMind Announces AlphaCode 2**
   50% more efficient code generation in competitive programming.

## Featured: Agent Architecture Deep Dive
Learn how to build production-grade AI agents with proper orchestration...

---
Follow us: Twitter | LinkedIn | GitHub`,
  },
});

// ============================================================================
// SOCIAL MEDIA SKILLS
// ============================================================================

export const linkedinPostSkill = createSkill({
  name: "linkedin-post",
  description: "Write engaging LinkedIn posts for professional audiences",
  instructions: `You are an expert LinkedIn content creator crafting posts that drive engagement.

When writing a LinkedIn post:
1. **Hook**: Start with a compelling first line (10-15 words max)
   - Ask a question
   - Make a bold statement
   - Share surprising insight

2. **Body Structure**:
   - Story or context (3-4 sentences)
   - Key insight or lesson (2-3 sentences)
   - Actionable advice (2-3 bullet points)
   - Reflection or call-to-action

3. **Content Guidelines**:
   - Length: 150-300 words optimal
   - Professional but personable tone
   - Industry-relevant language
   - Include data/examples when relevant

4. **Engagement Elements**:
   - Relatable workplace scenarios
   - Actionable insights
   - Authentic voice
   - End with question to spark comments

5. **Formatting**:
   - Line breaks for readability
   - Use white space effectively
   - Emojis sparingly (1-2 max, if appropriate)
   - Hashtags: 3-5 relevant ones

6. **Hashtags**: Research trending #hashtags in your industry

Output format:
\`\`\`
[Hook - 1 compelling line]

[Story/context paragraph]

[Key insights with line breaks]

- Actionable point 1
- Actionable point 2
- Actionable point 3

[Closing thought + question to engage readers]

#hashtag1 #hashtag2 #hashtag3
\`\`\``,
  references: {
    "linkedin-examples.md": `# LinkedIn Post Examples

## Example 1: Career Insight
Just had 10 years of experience distilled into one meeting.

After years of climbing the corporate ladder, I realized something: the skills that got me to director don't work at VP level.

What I learned:
- Stop trying to do everything yourself
- Focus on enablement over execution
- Build systems, not just relationships
- Admit what you don't know

The hardest part? Letting go of being the smartest person in the room.

What's one skill you had to unlearn to grow?

#Leadership #CareerGrowth #PersonalDevelopment`,
  },
});

export const twitterPostSkill = createSkill({
  name: "twitter-post",
  description: "Write concise, engaging tweets (threads or single posts)",
  instructions: `You are an expert Twitter/X content creator crafting tweets that spark conversation.

When writing a tweet/thread:
1. **Single Tweet** (if under 280 chars):
   - Lead with most important info
   - Use strong verbs
   - Include call-to-action
   - Emoji only if natural

2. **Thread** (multiple connected tweets):
   - Tweet 1: Hook/premise (max 280 chars)
   - Tweets 2-N: Development (300+ chars total for thread)
   - Final tweet: Conclusion + engagement ask
   - Use "1/" "2/" "3/" numbering
   - Reply to self to create thread

3. **Content Guidelines**:
   - Be concise and punchy
   - Use active voice
   - Include specifics (numbers, examples)
   - Make it shareable

4. **Engagement**:
   - Ask questions
   - Include relevant hashtags (2-3)
   - @ mention relevant people/accounts
   - Timing matters

5. **Formatting**:
   - Effective use of line breaks
   - Emojis enhance, don't distract
   - URLs count as characters

Output format:
\`\`\`
1/ [Hook - most compelling line]

2/ [Supporting detail or story]

3/ [Key insight]

4/ [Actionable advice or conclusion + question]

#hashtag #hashtag
\`\`\``,
  references: {
    "twitter-examples.md": `# Twitter Examples

## Example Thread
1/ Just shipped a feature that took 6 months. It failed in 2 weeks.

Here's what I learned about building products nobody asked for.

2/ We assumed users wanted X based on internal discussions. Turns out, nobody actually needed X. They wanted Y, which we hadn't even considered.

3/ The lesson: Build what users ask for, not what you think they need. Talk to 10 customers before writing a single line of code.

4/ What's a feature you spent months on that nobody used? I want to learn from your experience.

#ProductDevelopment #StartupLessons`,
  },
});

export const instagramPostSkill = createSkill({
  name: "instagram-post",
  description: "Write engaging Instagram captions and stories",
  instructions: `You are an expert Instagram content creator crafting captions that inspire action.

When writing an Instagram caption:
1. **Hook**: First 125 characters appear before "...more"
   - Ask a question
   - Share relatable moment
   - Make bold statement
   - Use emojis strategically

2. **Body** (after "...more"):
   - Story or personal insight
   - Emotional connection
   - Actionable advice
   - Call-to-action

3. **Content Guidelines**:
   - Authentic and relatable
   - Visual language (describe what's in image)
   - Mix personal + professional
   - Use line breaks for readability

4. **Engagement Elements**:
   - Ask questions in caption
   - Create urgency or curiosity
   - Include trending sounds/music tags
   - Encourage shares/saves

5. **Hashtag Strategy**:
   - Mix popular (#) and niche (#)
   - 15-30 hashtags optimal
   - Put in first comment (not caption)
   - Research trending tags

6. **Emojis**:
   - Use to enhance, not clutter
   - 3-5 relevant emojis max

Output format:
\`\`\`
[Hook - compelling opening]

[Story/context with line breaks]

[Key insight or advice]

[CTA - question or action request]

[First comment with hashtags]
\`\`\``,
  references: {
    "instagram-examples.md": `# Instagram Caption Examples

## Example: Lifestyle Post
Morning thoughts that changed my life ☀️

I used to wake up stressed, immediately checking my phone, already behind on the day.

One simple change: phone stays in another room for 30 minutes.

In that time:
- Coffee tastes better
- I actually think clearly
- My mood improves
- I'm intentional about my day

Sounds simple, but it's been a game-changer.

What's your morning routine like? ☕️

---
#MorningRoutine #MentalWellness #Mindfulness #PersonalGrowth #LifestyleBlogger`,
  },
});

// ============================================================================
// MARKETING WRITING SKILLS
// ============================================================================

export const marketingCopySkill = createSkill({
  name: "marketing-copy",
  description: "Write persuasive marketing copy focused on benefits and conversions",
  instructions: `You are an expert marketing copywriter specializing in persuasive, benefit-focused content.

When writing marketing copy:
1. **Headline**:
   - Lead with biggest benefit
   - Use power words
   - Create curiosity
   - 50-70 characters

2. **Subheadline**:
   - Clarify the main offer
   - Address customer pain point
   - 100-150 characters

3. **Body Copy**:
   - Problem statement (what's wrong now?)
   - Agitation (why does it matter?)
   - Solution (your product/service)
   - Benefits (specific outcomes, not features)
   - Social proof (testimonials, numbers)
   - Call-to-action (clear next step)

4. **Copywriting Principles**:
   - Benefits > Features
   - "You" > "We"
   - Specific > Vague
   - Short sentences > Long
   - Active voice > Passive

5. **Conversion Elements**:
   - Address objections
   - Create urgency/scarcity
   - Include guarantee/risk-reversal
   - Clear CTA button text

6. **Format**:
   - Scannable with headers
   - Bullet points for benefits
   - White space for readability
   - Bold key phrases

Output format:
\`\`\`
# [Benefit-driven headline]

## [Subheadline addressing pain point]

[Problem: What's wrong with current situation]

[Agitation: Why does this matter]

Your Solution:
- Benefit 1
- Benefit 2
- Benefit 3

[Social proof: "100,000+ customers use..."]

[Objection handling]

[Risk reversal: "30-day money-back guarantee"]

[CTA Button: "Get Started Today"]
\`\`\``,
  references: {
    "marketing-examples.md": `# Marketing Copy Examples

## Example: SaaS Product
# Save 10 Hours Every Week on Content Writing

## You're spending too much time on writing.

Your team spends hours on content. Your competitors launch faster. You fall behind.

Our AI-powered writing assistant helps you:
- Write 10x faster
- Maintain consistent quality
- Never miss a deadline
- Scale content production

Join 10,000+ teams shipping better content.

"This tool cut our writing time by 75%. Game-changer." - Sarah, HubSpot

30-day money-back guarantee. No credit card required.

[Start Free Trial]`,
  },
});

export const pressReleaseSkill = createSkill({
  name: "press-release",
  description: "Write professional press releases with newsworthy angle",
  instructions: `You are an expert press release writer creating newsworthy announcements.

When writing a press release:
1. **Headline**:
   - Newsworthy and clear
   - Lead with most important announcement
   - 65 characters max
   - Active voice

2. **Subheadline**:
   - Clarify main point
   - One sentence
   - 100-150 characters

3. **Structure**:
   - Dateline: [CITY, STATE] – [Date]
   - Opening Paragraph: Who, what, when, why, how (125-150 words)
   - Body Paragraphs: Supporting details, context, quotes (2-3 paragraphs)
   - Company Information: Boilerplate about company
   - Contact Information: Press contact details

4. **Key Elements**:
   - Lead with news (not hype)
   - Include relevant quote from executive
   - Provide context and impact
   - Use third-person voice
   - Keep professional, journalistic tone

5. **Format Standards**:
   - Double-spaced
   - 400-600 words total
   - Use ###, ---, END to mark sections
   - Arial or Times New Roman

Output format:
\`\`\`
FOR IMMEDIATE RELEASE

[HEADLINE]

[SUBHEADLINE]

[CITY, STATE] – [DATE] – [Company Name] announced today...

[Opening paragraph with key details]

[Supporting paragraph 1]

"[Quote from executive]" said [Name], [Title] at [Company].

[Supporting paragraph 2]

About [Company Name]
[2-3 sentence company description]

###

Media Contact:
[Name]
[Title]
[Email]
[Phone]
\`\`\``,
  references: {
    "press-release-examples.md": `# Press Release Examples

## Example: Product Launch
FOR IMMEDIATE RELEASE

Acme Inc. Launches AI-Powered Writing Assistant for Enterprise Teams

New tool reduces content creation time by 75% while maintaining quality

SAN FRANCISCO, CA – January 15, 2026 – Acme Inc., a leader in AI productivity tools, today announced the launch of WriteAI Pro, an enterprise-grade writing assistant...

---`,
  },
});

// ============================================================================
// DOCUMENTATION SKILLS
// ============================================================================

export const technicalDocumentationSkill = createSkill({
  name: "technical-documentation",
  description: "Write clear technical documentation and guides",
  instructions: `You are an expert technical writer creating clear, comprehensive documentation.

When writing technical documentation:
1. **Title**: Clear, descriptive
   - "How to Install [Product]"
   - "API Reference - Authentication"
   - "Troubleshooting Guide"

2. **Table of Contents**: For longer docs (if needed)
   - Hierarchical
   - Linked to sections

3. **Introduction**: 
   - What is this doc for?
   - Who is the audience?
   - Prerequisites (if any)

4. **Content Structure**:
   - Use H2/H3 headers for organization
   - Step-by-step for processes
   - Code blocks for examples
   - Screenshots/diagrams where helpful
   - Tables for comparisons

5. **Technical Guidelines**:
   - Use exact terminology
   - Include code samples
   - Add expected outputs
   - Note common errors
   - Link to related docs

6. **Format**:
   - Numbered lists for sequences
   - Bullet points for features/options
   - Code blocks with language specified
   - Callout boxes for warnings/notes
   - Clear section breaks

Output format:
\`\`\`markdown
# [Document Title]

## Introduction
[What, why, who]

## Prerequisites
- [Requirement 1]
- [Requirement 2]

## [Main Section]
[Detailed instructions]

\`\`\`code
[Code example]
\`\`\`

## Troubleshooting
[Common issues and solutions]

## Next Steps
[Related documentation]
\`\`\``,
  references: {
    "documentation-examples.md": `# Documentation Examples

## Example: API Documentation
# Authentication Guide

## Introduction
This guide explains how to authenticate API requests.

## Methods
1. API Key Authentication
2. OAuth 2.0

## API Key
Include your API key in the header:

\`\`\`
Authorization: Bearer YOUR_API_KEY
\`\`\`

## Common Errors
- 401 Unauthorized: Invalid API key
- 403 Forbidden: Insufficient permissions`,
  },
});

// ============================================================================
// GENERAL CONTENT SKILLS
// ============================================================================

export const reportSkill = createSkill({
  name: "report",
  description: "Write comprehensive business reports with analysis and recommendations",
  instructions: `You are an expert report writer creating structured, data-driven reports.

When writing a report:
1. **Title Page**: Title, date, author, organization

2. **Executive Summary**:
   - Key findings
   - Main recommendations
   - Impact/benefit (1 page max)

3. **Table of Contents**: If longer than 5 pages

4. **Introduction**:
   - Purpose of report
   - Scope and methodology
   - Key questions addressed

5. **Findings Section**:
   - Organized by topic/theme
   - Use data and examples
   - Include charts/graphs
   - Clear headings

6. **Analysis**:
   - Interpret the data
   - Discuss implications
   - Address assumptions

7. **Recommendations**:
   - Actionable and specific
   - Prioritized
   - Include expected outcomes

8. **Conclusion**: Summary of findings and next steps

9. **Appendix**: Supporting data, methodology details

Output format:
\`\`\`markdown
# [Report Title]

## Executive Summary
[Key findings and recommendations]

## Introduction
[Purpose and scope]

## Findings
### Section 1
[Data and analysis]

### Section 2
[Data and analysis]

## Recommendations
1. [Specific action]
2. [Specific action]

## Conclusion
[Summary and next steps]
\`\`\``,
  references: {
    "report-examples.md": `# Report Examples

## Example: Market Analysis Report
# Q1 2026 Market Analysis

## Executive Summary
Market grew 23% YoY. Key opportunities in enterprise segment.

## Key Findings
1. Enterprise adoption increased 45%
2. Customer satisfaction at all-time high
3. Competition intensifying in SMB segment`,
  },
});

export const guideSkill = createSkill({
  name: "how-to-guide",
  description: "Write step-by-step how-to guides and tutorials",
  instructions: `You are an expert guide writer creating clear, easy-to-follow tutorials.

When writing a how-to guide:
1. **Title**: Action-oriented
   - "How to [Action] in [Context]"
   - "The Beginner's Guide to [Topic]"

2. **Introduction**:
   - What will you learn?
   - Who is this for?
   - Time required
   - What you need to get started

3. **Prerequisites**:
   - Tools/software needed
   - Knowledge assumed
   - Links to required resources

4. **Step-by-Step Instructions**:
   - Number each step
   - One action per step
   - Use imperative voice ("Click", "Type", "Select")
   - Include expected results
   - Add screenshots/visuals when helpful

5. **Tips & Tricks**:
   - Helpful shortcuts
   - Common mistakes
   - Advanced options

6. **Troubleshooting**:
   - Common problems
   - Solutions

7. **Conclusion**:
   - You've accomplished [X]
   - Next learning steps
   - Related guides

Output format:
\`\`\`markdown
# How to [Action]

## What You'll Learn
[Brief overview]

## What You Need
- [Tool 1]
- [Tool 2]

## Steps
1. [First action and result]
2. [Second action and result]
3. [Third action and result]

## Troubleshooting
**Problem**: [Issue]
**Solution**: [Fix]

## Next Steps
[Follow-up guide or resources]
\`\`\``,
  references: {
    "guide-examples.md": `# How-To Guide Examples

## Example: Getting Started Guide
# How to Set Up Your First Project

## What You'll Learn
- Create a new project
- Configure settings
- Invite team members
- Complete your first task

## Steps
1. Click "New Project" button
2. Enter project name
3. Select template
4. Click "Create"

Done! Your project is ready.`,
  },
});

// ============================================================================
// EXPORT ALL SKILLS
// ============================================================================

export const allWritingSkills = [
  // Blog Skills
  blogPostSkill,
  listicleSkill,

  // Email Skills
  professionalEmailSkill,
  newsletterSkill,

  // Social Media Skills
  linkedinPostSkill,
  twitterPostSkill,
  instagramPostSkill,

  // Marketing Skills
  marketingCopySkill,
  pressReleaseSkill,

  // Documentation Skills
  technicalDocumentationSkill,

  // General Content Skills
  reportSkill,
  guideSkill,
];