import psycopg2
  import psycopg2.extras
  import os
  import time
  import logging

  logger = logging.getLogger(__name__)

  DATABASE_URL = os.getenv('DATABASE_URL')

  def get_connection():
      if not DATABASE_URL:
          return psycopg2.connect("postgresql://postgres@localhost/postgres")

      base_url = DATABASE_URL.split('?')[0]

      max_retries = 5
      for i in range(max_retries):
          try:
              conn = psycopg2.connect(
                  base_url,
                  sslmode='require',
                  connect_timeout=15
              )
              return conn
          except Exception as e:
              logger.error(f"Attempt {i+1} to connect failed: {e}")
              if i < max_retries - 1:
                  time.sleep(3)
              else:
                  raise e

  def init_db():
      print("جاري تهيئة قاعدة البيانات...")
      try:
          conn = get_connection()
          cursor = conn.cursor()
          cursor.execute('''
          CREATE TABLE IF NOT EXISTS projects (
              id SERIAL PRIMARY KEY,
              name TEXT UNIQUE NOT NULL,
              description TEXT
          )
          ''')
          cursor.execute('''
          CREATE TABLE IF NOT EXISTS knowledge (
              id SERIAL PRIMARY KEY,
              project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
              content TEXT NOT NULL
          )
          ''')
          cursor.execute('''
          CREATE TABLE IF NOT EXISTS chat_history (
              id SERIAL PRIMARY KEY,
              project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
              role TEXT,
              content TEXT,
              timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
          ''')
          cursor.execute('''
          CREATE TABLE IF NOT EXISTS user_state (
              user_id BIGINT PRIMARY KEY,
              current_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL
          )
          ''')
          conn.commit()
          cursor.close()
          conn.close()
          print("تمت تهيئة قاعدة البيانات بنجاح")
      except Exception as e:
          print(f"فشل تهيئة قاعدة البيانات: {e}")

  def add_project(name, description=""):
      try:
          conn = get_connection()
          cursor = conn.cursor()
          cursor.execute('SELECT id FROM projects WHERE LOWER(TRIM(name)) = LOWER(TRIM(%s))', (name,))
          existing = cursor.fetchone()
          if existing:
              cursor.close()
              conn.close()
              return None
          cursor.execute('INSERT INTO projects (name, description) VALUES (%s, %s) RETURNING id', (name, description))
          project_id = cursor.fetchone()[0]
          conn.commit()
          cursor.close()
          conn.close()
          return project_id
      except Exception as e:
          logger.error(f"Error adding project: {e}")
          return None

  def get_projects():
      try:
          conn = get_connection()
          cursor = conn.cursor()
          cursor.execute('SELECT id, name FROM projects ORDER BY id DESC')
          results = cursor.fetchall()
          cursor.close()
          conn.close()
          return results
      except Exception as e:
          logger.error(f"Error getting projects: {e}")
          return []

  def get_project_by_name(name):
      try:
          conn = get_connection()
          cursor = conn.cursor()
          cursor.execute('SELECT id, name FROM projects WHERE LOWER(TRIM(name)) = LOWER(TRIM(%s))', (name,))
          result = cursor.fetchone()
          cursor.close()
          conn.close()
          return result
      except Exception as e:
          logger.error(f"Error getting project by name: {e}")
          return None

  def set_user_project(user_id, project_id):
      try:
          conn = get_connection()
          cursor = conn.cursor()
          cursor.execute('''
              INSERT INTO user_state (user_id, current_project_id)
              VALUES (%s, %s)
              ON CONFLICT (user_id)
              DO UPDATE SET current_project_id = EXCLUDED.current_project_id
          ''', (user_id, project_id))
          conn.commit()
          cursor.close()
          conn.close()
      except Exception as e:
          logger.error(f"Error setting user project: {e}")

  def get_user_project(user_id):
      try:
          conn = get_connection()
          cursor = conn.cursor()
          cursor.execute('SELECT current_project_id FROM user_state WHERE user_id = %s', (user_id,))
          result = cursor.fetchone()
          cursor.close()
          conn.close()
          return result[0] if result else None
      except Exception as e:
          logger.error(f"Error getting user project: {e}")
          return None

  def add_knowledge(project_id, content):
      try:
          conn = get_connection()
          cursor = conn.cursor()
          cursor.execute('INSERT INTO knowledge (project_id, content) VALUES (%s, %s)', (project_id, content))
          conn.commit()
          cursor.close()
          conn.close()
      except Exception as e:
          logger.error(f"Error adding knowledge: {e}")

  def get_project_knowledge(project_id):
      try:
          conn = get_connection()
          cursor = conn.cursor()
          cursor.execute('SELECT content FROM knowledge WHERE project_id = %s', (project_id,))
          knowledge = cursor.fetchall()
          cursor.close()
          conn.close()
          return [k[0] for k in knowledge]
      except Exception as e:
          logger.error(f"Error getting knowledge: {e}")
          return []

  def add_chat_history(project_id, role, content):
      try:
          conn = get_connection()
          cursor = conn.cursor()
          cursor.execute('INSERT INTO chat_history (project_id, role, content) VALUES (%s, %s, %s)', (project_id, role, content))
          conn.commit()
          cursor.close()
          conn.close()
      except Exception as e:
          logger.error(f"Error adding chat history: {e}")

  def get_chat_history(project_id, limit=10):
      try:
          conn = get_connection()
          cursor = conn.cursor()
          cursor.execute('SELECT role, content FROM chat_history WHERE project_id = %s ORDER BY timestamp DESC LIMIT %s', (project_id, limit))
          history = cursor.fetchall()
          cursor.close()
          conn.close()
          return history[::-1]
      except Exception as e:
          logger.error(f"Error getting chat history: {e}")
          return []
  