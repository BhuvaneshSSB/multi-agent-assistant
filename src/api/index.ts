import { Express, Request, Response } from "express";
import { handleChat } from "./chat";

export function setupRoutes(app: Express) {
  // Chat endpoint
  app.post("/api/chat", handleChat);

  /**
   * @openapi
   * /api/status:
   *   get:
   *     summary: API status
   *     tags: [System]
   *     responses:
   *       200:
   *         description: Current API status
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                 agents:
   *                   type: array
   *                   items:
   *                     type: string
   *                 memory:
   *                   type: string
   *                 timestamp:
   *                   type: string
   *                   format: date-time
   */
  app.get("/api/status", (req: Request, res: Response) => {
    res.json({
      message: "Multi-agent assistant API running",
      agents: ["supervisor", "research", "document", "writer"],
      memory: "enabled",
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * @openapi
   * /api/agents:
   *   get:
   *     summary: List available agents
   *     tags: [Agents]
   *     responses:
   *       200:
   *         description: Registered agents
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 agents:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id:
   *                         type: string
   *                       name:
   *                         type: string
   *                       description:
   *                         type: string
   */
  app.get("/api/agents", (req: Request, res: Response) => {
    res.json({
      agents: [
        {
          id: "supervisor",
          name: "Supervisor Agent",
          description: "Orchestrates other agents",
        },
        {
          id: "research-agent",
          name: "Research Agent",
          description: "Gathers web information",
        },
        {
          id: "document-agent",
          name: "Document Agent",
          description: "Analyzes documents",
        },
        {
          id: "writer-agent",
          name: "Writer Agent",
          description: "Generates content",
        },
      ],
    });
  });
}