import swaggerJsdoc from "swagger-jsdoc";
import { config } from "./env";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.3",
    info: {
      title: "Multi-Agent Assistant API",
      version: "1.0.0",
      description:
        "HTTP API for the multi-agent assistant (supervisor, research, document, and writer agents).",
    },
    servers: [
      {
        url: `http://localhost:${config.api.port}`,
      },
    ],
    components: {
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
            code: { type: "string" },
          },
        },
      },
    },
  },
  // Covers both `tsx` dev runs (reads .ts sources) and the compiled `dist` build.
  apis: ["./src/app.ts", "./src/api/*.ts", "./dist/app.js", "./dist/api/*.js"],
};

export const swaggerSpec = swaggerJsdoc(options);
