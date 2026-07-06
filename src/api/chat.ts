import { Request, Response, NextFunction } from "express";
import { supervisorAgent } from "../mastra/agents/supervisor";
import { ValidationError, AppError } from "../types/index";

/**
 * @openapi
 * /api/chat:
 *   post:
 *     summary: Send a message to the supervisor agent
 *     tags: [Chat]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [conversationId, userId, message]
 *             properties:
 *               conversationId:
 *                 type: string
 *               userId:
 *                 type: string
 *               message:
 *                 type: string
 *     responses:
 *       200:
 *         description: Assistant response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 conversationId:
 *                   type: string
 *                 userId:
 *                   type: string
 *                 userMessage:
 *                   type: string
 *                 assistantMessage:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 executionTimeMs:
 *                   type: number
 *                 agentsInvolved:
 *                   type: array
 *                   items:
 *                     type: string
 *       400:
 *         description: Missing or invalid fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export async function handleChat(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { conversationId, userId, message } = req.body;

    // Validation
    if (!message || typeof message !== "string") {
      throw new ValidationError("message is required and must be a string");
    }

    if (!conversationId) {
      throw new ValidationError("conversationId is required");
    }

    if (!userId) {
      throw new ValidationError("userId is required");
    }

    console.log(`[Chat] User: ${userId}, Conversation: ${conversationId}`);
    console.log(`[Chat] Message: ${message.substring(0, 100)}...`);

    // Call supervisor agent
    const startTime = Date.now();
    
    const response = await supervisorAgent.generate(message, {
      memory: {
        thread: conversationId,
        resource: userId,
      },
      maxSteps: 10, // Allow supervisor to make up to 10 agent calls
    });

    const executionTime = Date.now() - startTime;

    console.log(`[Chat] Response generated in ${executionTime}ms`);

    // Return response
    res.status(200).json({
      conversationId,
      userId,
      userMessage: message,
      assistantMessage: response.text || response,
      timestamp: new Date().toISOString(),
      executionTimeMs: executionTime,
      agentsInvolved: ["supervisor"], // You can track this later
    });
  } catch (error) {
    console.error("[Chat] Error:", error);
    next(error);
  }
}