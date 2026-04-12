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
    // Create tables if not exist (base schema without new columns)
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        api_token TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_history (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        telegram_user_id BIGINT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_sessions (
        id SERIAL PRIMARY KEY,
        telegram_user_id BIGINT NOT NULL UNIQUE,
        active_project_id INTEGER REFERENCES projects(id),
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);

    // Migration: rename 'token' → 'api_token' if old schema
    const hasToken = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'token'
    `);
    if (hasToken.rows.length > 0) {
      console.log("Migration: renaming 'token' → 'api_token'");
      await client.query(`ALTER TABLE projects RENAME COLUMN token TO api_token`);
    }

    // Migration: add api_token if missing
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS api_token TEXT`);

    // Migration: fill NULL api_tokens
    const nullProjects = await client.query(`SELECT id FROM projects WHERE api_token IS NULL`);
    for (const row of nullProjects.rows) {
      const token = randomBytes(32).toString("hex");
      await client.query(`UPDATE projects SET api_token = $1 WHERE id = $2`, [token, row.id]);
    }

    // Migration: add UNIQUE constraint on api_token
    const hasUnique = await client.query(`
      SELECT 1 FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
      WHERE tc.table_name = 'projects'
        AND tc.constraint_type = 'UNIQUE'
        AND ccu.column_name = 'api_token'
    `);
    if (hasUnique.rows.length === 0) {
      await client.query(`ALTER TABLE projects ADD CONSTRAINT projects_api_token_unique UNIQUE (api_token)`);
    }

    // Migration: add label and summary columns to knowledge (safe, IF NOT EXISTS)
    await client.query(`ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS label TEXT`);
    await client.query(`ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS summary TEXT`);

    console.log("✅ Database tables ready");
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
  const result = await pool.query(
    "SELECT id, name, description, api_token, created_at FROM projects ORDER BY created_at ASC"
  );
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
  summary?: string
) {
  const result = await pool.query(
    "INSERT INTO knowledge (project_id, content, label, summary) VALUES ($1, $2, $3, $4) RETURNING *",
    [projectId, content, label ?? null, summary ?? null]
  );
  return result.rows[0] as KnowledgeItem;
}

export async function getKnowledge(projectId: number): Promise<KnowledgeItem[]> {
  // Try with label/summary columns first, fallback if they don't exist yet
  try {
    const result = await pool.query(
      "SELECT id, label, summary, content, created_at FROM knowledge WHERE project_id = $1 ORDER BY created_at ASC",
      [projectId]
    );
    return result.rows as KnowledgeItem[];
  } catch {
    // Fallback: columns might not exist in old DB
    const result = await pool.query(
      "SELECT id, content, created_at FROM knowledge WHERE project_id = $1 ORDER BY created_at ASC",
      [projectId]
    );
    return (result.rows as { id: number; content: string; created_at: Date }[]).map((r) => ({
      id: r.id,
      label: null,
      summary: null,
      content: r.content,
      created_at: r.created_at,
    }));
  }
}

export async function getKnowledgeByLabel(projectId: number, label: string): Promise<KnowledgeItem | undefined> {
  const result = await pool.query(
    `SELECT id, label, summary, content, created_at FROM knowledge
     WHERE project_id = $1 AND LOWER(label) = LOWER($2)
     ORDER BY created_at DESC LIMIT 1`,
    [projectId, label]
  );
  return result.rows[0] as KnowledgeItem | undefined;
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
  const params: (number | undefined)[] = [projectId];
  if (telegramUserId) {
    query += " AND telegram_user_id = $2";
    params.push(telegramUserId);
    query += ` ORDER BY created_at DESC LIMIT $3`;
    params.push(limit);
  } else {
    query += ` ORDER BY created_at DESC LIMIT $2`;
    params.push(limit);
  }
  const result = await pool.query(query, params);
  return (result.rows as { role: string; content: string }[]).reverse();
}

export interface Project {
  id: number;
  name: string;
  description: string | null;
  api_token: string;
  created_at: Date;
}

export interface KnowledgeItem {
  id: number;
  label: string | null;
  summary: string | null;
  content: string;
  created_at: Date;
}
