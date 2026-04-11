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
    // Step 1: Create tables (api_token nullable initially for safe migration)
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

    // Step 2: Handle old Python schema (column was named 'token')
    const hasToken = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'token'
    `);
    if (hasToken.rows.length > 0) {
      console.log("Migration: renaming 'token' → 'api_token'");
      await client.query(`ALTER TABLE projects RENAME COLUMN token TO api_token`);
    }

    // Step 3: Add api_token column if still missing
    const hasApiToken = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'api_token'
    `);
    if (hasApiToken.rows.length === 0) {
      console.log("Migration: adding 'api_token' column");
      await client.query(`ALTER TABLE projects ADD COLUMN api_token TEXT`);
    }

    // Step 4: Fill NULL api_tokens for any existing rows (using Node.js crypto, not pg extension)
    const nullProjects = await client.query(`SELECT id FROM projects WHERE api_token IS NULL`);
    for (const row of nullProjects.rows) {
      const token = randomBytes(32).toString("hex");
      await client.query(`UPDATE projects SET api_token = $1 WHERE id = $2`, [token, row.id]);
      console.log(`Migration: generated api_token for project id=${row.id}`);
    }

    // Step 5: Add UNIQUE constraint if not present
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

export async function addKnowledge(projectId: number, content: string) {
  const result = await pool.query(
    "INSERT INTO knowledge (project_id, content) VALUES ($1, $2) RETURNING *",
    [projectId, content]
  );
  return result.rows[0];
}

export async function getKnowledge(projectId: number) {
  const result = await pool.query(
    "SELECT id, content, created_at FROM knowledge WHERE project_id = $1 ORDER BY created_at ASC",
    [projectId]
  );
  return result.rows as { id: number; content: string; created_at: Date }[];
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
