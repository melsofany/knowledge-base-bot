import { Router, Request, Response, NextFunction } from "express";
import {
  getProjectByToken,
  getKnowledge,
  getKnowledgeByLabel,
  addKnowledge,
  createProject,
  getProjects,
} from "./database.js";
import { getAiResponse, analyzeAndNameKnowledge } from "./ai.js";
import { pool } from "./database.js";

const router = Router();

function getToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const parts = auth.split(" ");
  return parts[0] === "Bearer" && parts[1] ? parts[1] : null;
}

async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path.startsWith("/admin")) return next();
  const token = getToken(req);
  if (!token) { res.status(401).json({ error: "Authorization: Bearer <token> required" }); return; }
  const project = await getProjectByToken(token);
  if (!project) { res.status(401).json({ error: "Invalid API token" }); return; }
  (req as Request & { project: typeof project }).project = project;
  next();
}

router.use(authMiddleware);

router.get("/info", async (req, res) => {
  const p = (req as Request & { project: { id: number; name: string; description: string | null } }).project;
  res.json({ id: p.id, name: p.name, description: p.description });
});

// GET all knowledge — returns list with labels and summaries
router.get("/knowledge", async (req, res) => {
  const p = (req as Request & { project: { id: number; name: string } }).project;
  const knowledge = await getKnowledge(p.id);
  const items = knowledge.map((k) => ({
    id: k.id,
    label: k.label ?? null,
    summary: k.summary ?? null,
    content: k.content,
    created_at: k.created_at,
  }));
  res.json({
    project: p.name,
    total: items.length,
    labels: items.map((k) => k.label).filter(Boolean),
    knowledge: items,
  });
});

// GET knowledge by label name — for external agents
// Usage: GET /api/project/knowledge/by-label/mev_arbitrage_strategy
router.get("/knowledge/by-label/:label", async (req, res) => {
  const p = (req as unknown as Request & { project: { id: number; name: string } }).project;
  const { label } = req.params;
  if (!label) { res.status(400).json({ error: "label is required" }); return; }
  const item = await getKnowledgeByLabel(p.id, label);
  if (!item) {
    res.status(404).json({ error: `No knowledge found with label: ${label}` });
    return;
  }
  res.json({
    project: p.name,
    label: item.label,
    summary: item.summary,
    content: item.content,
    created_at: item.created_at,
  });
});

// POST knowledge — auto-analyzes and names it if label not provided
router.post("/knowledge", async (req, res) => {
  const p = (req as Request & { project: { id: number; name: string } }).project;
  const { content, label, summary } = req.body as { content?: string; label?: string; summary?: string };
  if (!content?.trim()) { res.status(400).json({ error: "content is required" }); return; }

  let finalLabel = label?.trim();
  let finalSummary = summary?.trim();

  if (!finalLabel) {
    const analyzed = await analyzeAndNameKnowledge(content.trim());
    finalLabel = analyzed.label;
    finalSummary = finalSummary ?? analyzed.summary;
  }

  const item = await addKnowledge(p.id, content.trim(), finalLabel, finalSummary);
  res.status(201).json({ success: true, knowledge: item });
});

router.post("/chat", async (req, res) => {
  const p = (req as Request & { project: { id: number; name: string } }).project;
  const { message, user_id } = req.body as { message?: string; user_id?: number };
  if (!message?.trim()) { res.status(400).json({ error: "message is required" }); return; }
  const reply = await getAiResponse(p.id, message.trim(), user_id);
  res.json({ project: p.name, message: reply });
});

router.get("/history", async (req, res) => {
  const p = (req as Request & { project: { id: number; name: string } }).project;
  const limit = Math.min(parseInt((req.query.limit as string) ?? "20"), 100);
  const userId = req.query.user_id ? parseInt(req.query.user_id as string) : undefined;
  const result = await pool.query(
    `SELECT role, content, created_at FROM chat_history WHERE project_id = $1
     ${userId ? "AND telegram_user_id = $2" : ""} ORDER BY created_at DESC LIMIT ${userId ? "$3" : "$2"}`,
    userId ? [p.id, userId, limit] : [p.id, limit]
  );
  res.json({ project: p.name, history: result.rows.reverse() });
});

router.post("/admin/projects", async (req, res) => {
  const adminKey = process.env.ADMIN_API_KEY;
  if (adminKey && getToken(req) !== adminKey) { res.status(401).json({ error: "Admin key required" }); return; }
  const { name, description } = req.body as { name?: string; description?: string };
  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  try {
    const project = await createProject(name, description);
    res.status(201).json(project);
  } catch {
    res.status(409).json({ error: "Project name already exists" });
  }
});

router.get("/admin/projects", async (req, res) => {
  const adminKey = process.env.ADMIN_API_KEY;
  if (adminKey && getToken(req) !== adminKey) { res.status(401).json({ error: "Admin key required" }); return; }
  const projects = await getProjects();
  res.json({ projects });
});

export default router;
