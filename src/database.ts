import pg from "pg";
import { randomBytes } from "crypto";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : false,
});

export async function initDatabase() {
  const client = await pool.connect();
  try {
    // Enable pgvector extension
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    // Create tables if not exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        api_token TEXT UNIQUE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS knowledge (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        label TEXT,
        summary TEXT,
        category TEXT,
        metadata JSONB DEFAULT '{}',
        embedding vector(1536),
        version INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS knowledge_versions (
        id SERIAL PRIMARY KEY,
        knowledge_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS feedback (
        id SERIAL PRIMARY KEY,
        knowledge_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
        agent_id TEXT,
        rating INTEGER,
        comment TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS chat_history (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        telegram_user_id BIGINT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_sessions (
        id SERIAL PRIMARY KEY,
        telegram_user_id BIGINT NOT NULL UNIQUE,
        active_project_id INTEGER REFERENCES projects(id),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Migrations for existing tables
    const migrations = [
      `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS category TEXT`,
      `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'`,
      `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS embedding vector(1536)`,
      `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1`,
      `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`,
    ];

    for (const sql of migrations) {
      try {
        await client.query(sql);
      } catch (e) {
        console.warn("Migration warning:", (e as Error).message);
      }
    }

    console.log("✅ Database schema updated with pgvector and source-of-truth fields");
  } catch (err) {
    console.error("❌ Database init error:", err);
    throw err;
  } finally {
    client.release();
  }
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export async function createProject(name: string, description?: string) {
  const token = generateToken();
  const result = await pool.query(
    "INSERT INTO projects (name, description, api_token) VALUES ($1, $2, $3) RETURNING *",
    [name, description ?? null, token]
  );
  return result.rows[0] as Project;
}

export async function getProjects(): Promise<Project[]> {
  const result = await pool.query("SELECT * FROM projects ORDER BY id ASC");
  return result.rows as Project[];
}

export async function getProjectById(id: number): Promise<Project | undefined> {
  const result = await pool.query("SELECT * FROM projects WHERE id = $1", [id]);
  return result.rows[0] as Project | undefined;
}

export async function getProjectByToken(token: string): Promise<Project | undefined> {
  const result = await pool.query("SELECT * FROM projects WHERE api_token = $1", [token]);
  return result.rows[0] as Project | undefined;
}

export async function addKnowledge(
  projectId: number,
  content: string,
  label?: string,
  summary?: string,
  category?: string,
  metadata: any = {},
  embedding?: number[]
) {
  const result = await pool.query(
    `INSERT INTO knowledge (project_id, content, label, summary, category, metadata, embedding) 
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [projectId, content, label ?? null, summary ?? null, category ?? null, JSON.stringify(metadata), embedding ? `[${embedding.join(",")}]` : null]
  );
  return result.rows[0] as KnowledgeItem;
}

export async function updateKnowledge(
  id: number,
  content: string,
  label?: string,
  summary?: string,
  category?: string,
  metadata?: any,
  embedding?: number[]
) {
  // Save current version to history before updating
  const current = await pool.query("SELECT content, version FROM knowledge WHERE id = $1", [id]);
  if (current.rows[0]) {
    await pool.query(
      "INSERT INTO knowledge_versions (knowledge_id, content, version) VALUES ($1, $2, $3)",
      [id, current.rows[0].content, current.rows[0].version]
    );
  }

  const result = await pool.query(
    `UPDATE knowledge SET 
      content = $1, label = $2, summary = $3, category = $4, 
      metadata = COALESCE($5, metadata), embedding = COALESCE($6, embedding),
      version = version + 1, updated_at = NOW()
     WHERE id = $7 RETURNING *`,
    [content, label ?? null, summary ?? null, category ?? null, metadata ? JSON.stringify(metadata) : null, embedding ? `[${embedding.join(",")}]` : null, id]
  );
  return result.rows[0] as KnowledgeItem;
}

export async function searchKnowledge(projectId: number, queryEmbedding: number[], limit = 5) {
  const result = await pool.query(
    `SELECT *, (embedding <=> $1) as distance 
     FROM knowledge 
     WHERE project_id = $2 AND embedding IS NOT NULL
     ORDER BY distance ASC LIMIT $3`,
    [`[${queryEmbedding.join(",")}]`, projectId, limit]
  );
  return result.rows as (KnowledgeItem & { distance: number })[];
}

export async function getKnowledge(projectId: number): Promise<KnowledgeItem[]> {
  const result = await pool.query(
    "SELECT * FROM knowledge WHERE project_id = $1 ORDER BY id ASC",
    [projectId]
  );
  return result.rows as KnowledgeItem[];
}

export async function getKnowledgeByLabel(projectId: number, label: string): Promise<KnowledgeItem | undefined> {
  const result = await pool.query(
    `SELECT * FROM knowledge WHERE project_id = $1 AND LOWER(label) = LOWER($2) ORDER BY id DESC LIMIT 1`,
    [projectId, label]
  );
  return result.rows[0] as KnowledgeItem | undefined;
}

export async function addFeedback(knowledgeId: number, agentId: string, rating: number, comment?: string) {
  await pool.query(
    "INSERT INTO feedback (knowledge_id, agent_id, rating, comment) VALUES ($1, $2, $3, $4)",
    [knowledgeId, agentId, rating, comment ?? null]
  );
}

export async function getKnowledgeVersions(knowledgeId: number) {
  const result = await pool.query(
    "SELECT * FROM knowledge_versions WHERE knowledge_id = $1 ORDER BY version DESC",
    [knowledgeId]
  );
  return result.rows;
}

export async function getUserSession(telegramUserId: number) {
  const result = await pool.query(
    "SELECT active_project_id FROM user_sessions WHERE telegram_user_id = $1",
    [telegramUserId]
  );
  return result.rows[0] as { active_project_id: number | null } | undefined;
}

export async function setUserSession(telegramUserId: number, projectId: number | null) {
  await pool.query(
    `INSERT INTO user_sessions (telegram_user_id, active_project_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (telegram_user_id)
     DO UPDATE SET active_project_id = $2, updated_at = NOW()`,
    [telegramUserId, projectId]
  );
}

export async function saveChatMessage(
  projectId: number,
  role: string,
  content: string,
  telegramUserId?: number
) {
  await pool.query(
    "INSERT INTO chat_history (project_id, role, content, telegram_user_id) VALUES ($1, $2, $3, $4)",
    [projectId, role, content, telegramUserId ?? null]
  );
}

export async function getChatHistory(projectId: number, telegramUserId?: number, limit = 10) {
  let query = "SELECT role, content FROM chat_history WHERE project_id = $1";
  const params: any[] = [projectId];
  if (telegramUserId) {
    query += " AND telegram_user_id = $2";
    params.push(telegramUserId);
    query += ` ORDER BY id DESC LIMIT $3`;
    params.push(limit);
  } else {
    query += ` ORDER BY id DESC LIMIT $2`;
    params.push(limit);
  }
  const result = await pool.query(query, params);
  return result.rows.reverse();
}

export interface Project {
  id: number;
  name: string;
  description: string | null;
  api_token: string;
  created_at: Date | null;
}

export interface KnowledgeItem {
  id: number;
  project_id: number;
  label: string | null;
  summary: string | null;
  content: string;
  category: string | null;
  metadata: any;
  version: number;
  created_at: Date | null;
  updated_at: Date | null;
}
