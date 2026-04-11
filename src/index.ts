import "dotenv/config";
import express from "express";
import cors from "cors";
import { initDatabase } from "./database.js";
import { createBot } from "./bot.js";
import projectRouter from "./api.js";

const PORT = parseInt(process.env.PORT ?? "3000");

async function main() {
  await initDatabase();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/", (_req, res) => {
    res.json({
      name: "Knowledge Base Bot API",
      version: "1.0.0",
      endpoints: {
        health: "GET /api/healthz",
        project_info: "GET /api/project/info",
        knowledge: "GET /api/project/knowledge",
        add_knowledge: "POST /api/project/knowledge",
        chat: "POST /api/project/chat",
        history: "GET /api/project/history",
        admin_projects: "GET|POST /api/project/admin/projects",
      },
      auth: "Authorization: Bearer <project-api-token>",
    });
  });

  app.get("/api/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/project", projectRouter);

  const bot = createBot();
  if (bot) {
    bot.launch().catch((err: unknown) => console.error("Bot error:", err));
    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
    console.log("✅ Telegram bot started");
  }

  app.listen(PORT, () => {
    console.log(`✅ Server listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
