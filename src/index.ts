import "dotenv/config";
import express from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";
import { initDatabase } from "./database.js";
import projectRouter from "./api.js";
import { createBot } from "./bot.js";

const app = express();
const PORT = parseInt(process.env.PORT ?? "3000");

app.use(cors());
app.use(express.json());

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Knowledge Base Bot API",
      version: "2.0.0",
      description: "API for AI Knowledge Base Bot - Source of Truth for AI Agents",
    },
    servers: [
      {
        url: process.env.API_BASE_URL || `http://localhost:${PORT}`,
      },
    ],
  },
  apis: ["./src/api.ts"],
};

const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs));

app.get("/", (req, res) => {
  res.json({
    name: "knowledge-base-bot",
    version: "2.0.0",
    status: "running",
    docs: "/api-docs",
    endpoints: {
      health: "/api/healthz",
      project: "/api/project",
    },
  });
});

app.get("/api/healthz", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/project", projectRouter);

async function start() {
  try {
    await initDatabase();
    
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📖 API Documentation: http://localhost:${PORT}/api-docs`);
    });

    const bot = createBot();
    if (bot) {
      bot.launch().catch((err: unknown) => console.error("Bot error:", err));
      console.log("🤖 Telegram bot launched");
      process.once("SIGINT", () => bot.stop("SIGINT"));
      process.once("SIGTERM", () => bot.stop("SIGTERM"));
    } else {
      console.warn("⚠️ TELEGRAM_BOT_TOKEN not found, bot not started");
    }
  } catch (err) {
    console.error("❌ Startup error:", err);
    process.exit(1);
  }
}

start();

process.once("SIGINT", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
