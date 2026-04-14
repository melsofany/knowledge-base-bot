import { Router, Request, Response, NextFunction } from "express";
import {
  getProjectByToken,
  getKnowledge,
  getKnowledgeByLabel,
  addKnowledge,
  createProject,
  getProjects,
  searchKnowledge,
  addFeedback,
  getKnowledgeVersions,
  updateKnowledge,
} from "./database.js";
import { getAiResponse, analyzeAndNameKnowledge, getEmbedding } from "./ai.js";
import { pool } from "./database.js";

const router = Router();

/**
 * @swagger
 * components:
 *   securitySchemes:
 *     bearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 */

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
  (req as any).project = project;
  next();
}

router.use(authMiddleware);

/**
 * @swagger
 * /api/project/info:
 *   get:
 *     summary: Get project information
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Project details
 */
router.get("/info", async (req, res) => {
  const p = (req as any).project;
  res.json({ id: p.id, name: p.name, description: p.description });
});

/**
 * @swagger
 * /api/project/knowledge:
 *   get:
 *     summary: Get all knowledge items for the project
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of knowledge items
 */
router.get("/knowledge", async (req, res) => {
  const p = (req as any).project;
  const knowledge = await getKnowledge(p.id);
  res.json({
    project: p.name,
    total: knowledge.length,
    knowledge,
  });
});

/**
 * @swagger
 * /api/project/knowledge/search:
 *   get:
 *     summary: Semantic search in knowledge base
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Relevant knowledge items
 */
router.get("/knowledge/search", async (req, res) => {
  const p = (req as any).project;
  const { q } = req.query;
  if (!q) { res.status(400).json({ error: "query (q) is required" }); return; }
  
  const embedding = await getEmbedding(q as string);
  const results = await searchKnowledge(p.id, embedding);
  res.json({ project: p.name, results });
});

/**
 * @swagger
 * /api/project/knowledge:
 *   post:
 *     summary: Add new knowledge item
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               content:
 *                 type: string
 *               label:
 *                 type: string
 *               category:
 *                 type: string
 *     responses:
 *       201:
 *         description: Knowledge item created
 */
router.post("/knowledge", async (req, res) => {
  const p = (req as any).project;
  const { content, label, summary, category, metadata } = req.body;
  if (!content?.trim()) { res.status(400).json({ error: "content is required" }); return; }

  let finalLabel = label?.trim();
  let finalSummary = summary?.trim();
  let finalCategory = category?.trim();
  let finalMetadata = metadata || {};

  if (!finalLabel || !finalCategory) {
    const analyzed = await analyzeAndNameKnowledge(content.trim());
    finalLabel = finalLabel || analyzed.label;
    finalSummary = finalSummary || analyzed.summary;
    finalCategory = finalCategory || analyzed.category;
    finalMetadata = { ...analyzed.metadata, ...finalMetadata };
  }

  const embedding = await getEmbedding(content.trim());
  const item = await addKnowledge(p.id, content.trim(), finalLabel, finalSummary, finalCategory, finalMetadata, embedding);
  res.status(201).json({ success: true, knowledge: item });
});

/**
 * @swagger
 * /api/project/knowledge/{id}/feedback:
 *   post:
 *     summary: Submit feedback for a knowledge item
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               rating:
 *                 type: integer
 *               comment:
 *                 type: string
 *               agent_id:
 *                 type: string
 *     responses:
 *       200:
 *         description: Feedback submitted
 */
router.post("/knowledge/:id/feedback", async (req, res) => {
  const { id } = req.params;
  const { rating, comment, agent_id } = req.body;
  if (rating === undefined) { res.status(400).json({ error: "rating is required" }); return; }
  
  await addFeedback(parseInt(id), agent_id || "unknown_agent", rating, comment);
  res.json({ success: true });
});

/**
 * @swagger
 * /api/project/knowledge/{id}/versions:
 *   get:
 *     summary: Get version history of a knowledge item
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of versions
 */
router.get("/knowledge/:id/versions", async (req, res) => {
  const { id } = req.params;
  const versions = await getKnowledgeVersions(parseInt(id));
  res.json({ versions });
});

router.post("/chat", async (req, res) => {
  const p = (req as any).project;
  const { message, user_id } = req.body;
  if (!message?.trim()) { res.status(400).json({ error: "message is required" }); return; }
  const reply = await getAiResponse(p.id, message.trim(), user_id);
  res.json({ project: p.name, message: reply });
});

router.get("/history", async (req, res) => {
  const p = (req as any).project;
  const limit = Math.min(parseInt((req.query.limit as string) ?? "20"), 100);
  const userId = req.query.user_id ? parseInt(req.query.user_id as string) : undefined;
  const result = await pool.query(
    `SELECT role, content, created_at FROM chat_history WHERE project_id = $1
     ${userId ? "AND telegram_user_id = $2" : ""} ORDER BY created_at DESC LIMIT ${userId ? "$3" : "$2"}`,
    userId ? [p.id, userId, limit] : [p.id, limit]
  );
  res.json({ project: p.name, history: result.rows.reverse() });
});

// Admin routes
router.post("/admin/projects", async (req, res) => {
  const adminKey = process.env.ADMIN_API_KEY;
  if (adminKey && getToken(req) !== adminKey) { res.status(401).json({ error: "Admin key required" }); return; }
  const { name, description } = req.body;
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
