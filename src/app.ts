import express, { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { config } from "./config/env";
import { initializeDatabase, testDatabaseConnection } from "./config/database";
import { swaggerSpec } from "./config/swagger";
import "./mastra/index";
import { setupRoutes } from "./api/index";
import { AppError } from "./types/index";

const app: Express = express();
const PORT = config.api.port;

// Middleware
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(cors());

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - startTime;
    console.log(
      `[HTTP] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`
    );
  });
  next();
});

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Health check
 *     tags: [System]
 *     responses:
 *       200:
 *         description: Server is up
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: healthy
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 uptime:
 *                   type: number
 */
app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Swagger / OpenAPI docs
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get("/api-docs.json", (req: Request, res: Response) => {
  res.json(swaggerSpec);
});

// Setup API routes
setupRoutes(app);

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: "Endpoint not found",
    path: req.path,
    method: req.method,
  });
});

// Error handler
app.use(
  (err: any, req: Request, res: Response, next: NextFunction) => {
    console.error("[Error]", err);

    if (err instanceof AppError) {
      return res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
      });
    }

    res.status(500).json({
      error: err.message || "Internal server error",
      code: "INTERNAL_SERVER_ERROR",
    });
  }
);

// Start server
async function start() {
  try {
    // Initialize database
    console.log("[Server] Initializing database...");
    initializeDatabase();
    const dbConnected = await testDatabaseConnection();

    if (!dbConnected) {
      console.warn("[Server] ⚠ Database connection failed. Some features may not work.");
    }

    // Start Express server
    const server = app.listen(PORT, () => {
      console.log(`[Server] ✓ Listening on http://localhost:${PORT}`);
      console.log(`[Server] ✓ Health check: http://localhost:${PORT}/health`);
      console.log(`[Server] ✓ API docs: http://localhost:${PORT}/api-docs`);
      console.log(`[Server] ✓ Status: http://localhost:${PORT}/api/status`);
      console.log(`[Server] ✓ Agents: http://localhost:${PORT}/api/agents`);
      console.log(`[Server] ✓ Chat: POST http://localhost:${PORT}/api/chat`);
    });

    // Graceful shutdown
    process.on("SIGTERM", () => {
      console.log("[Server] SIGTERM received, shutting down gracefully...");
      server.close(() => {
        console.log("[Server] Server closed");
        process.exit(0);
      });
    });

    process.on("SIGINT", () => {
      console.log("[Server] SIGINT received, shutting down gracefully...");
      server.close(() => {
        console.log("[Server] Server closed");
        process.exit(0);
      });
    });
  } catch (error) {
    console.error("[Server] Fatal error:", error);
    process.exit(1);
  }
}

start();

export default app;