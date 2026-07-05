import express, { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import { config } from "./config/env";
import { initializeDatabase, testDatabaseConnection } from "./config/database";
import { mastra } from "./mastra/index";

const app: Express = express();
const PORT = config.api.port;

// Middleware
app.use(express.json());
app.use(cors());

// Health check endpoint
app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Status endpoint with database info
app.get("/api/status", (req: Request, res: Response) => {
  res.json({
    message: "Multi-agent assistant API running",
    mastra: "initialized",
    environment: config.environment,
  });
});

// Error handler
app.use(
  (err: any, req: Request, res: Response, next: NextFunction) => {
    console.error("Error:", err);
    res.status(500).json({
      error: err.message || "Internal server error",
    });
  }
);

// Start server
async function start() {
  try {
    // Initialize database
    console.log("Initializing database...");
    initializeDatabase();
    const dbConnected = await testDatabaseConnection();

    if (!dbConnected) {
      console.warn("⚠ Warning: Database connection failed. Some features may not work.");
    }

    // Start Express server
    const server = app.listen(PORT, () => {
      console.log(`✓ Server running on http://localhost:${PORT}`);
      console.log(`✓ Health check: http://localhost:${PORT}/health`);
      console.log(`✓ Status: http://localhost:${PORT}/api/status`);
    });

    // Graceful shutdown
    process.on("SIGTERM", () => {
      console.log("SIGTERM received, shutting down...");
      server.close(() => {
        console.log("Server closed");
        process.exit(0);
      });
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

start();

export default app;