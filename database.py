import psycopg
import os
from psycopg_pool import ConnectionPool

# جلب رابط الاتصال بقاعدة البيانات من المتغيرات البيئية
DATABASE_URL = os.getenv('DATABASE_URL')

# إنشاء تجمع اتصالات (Connection Pool)
try:
    # psycopg v3 uses ConnectionPool from psycopg_pool
    postgreSQL_pool = ConnectionPool(DATABASE_URL, min_size=1, max_size=20)
    print("تم إنشاء تجمع الاتصالات بنجاح")
except Exception as e:
    print(f"خطأ في إنشاء تجمع الاتصالات: {e}")

def get_connection():
    return postgreSQL_pool.connection()

def release_connection(conn):
    # In psycopg v3, connection is usually used as a context manager or closed.
    # But if using the pool's connection() directly, it's better to let it handle it.
    # However, to keep the same structure:
    conn.close()

def init_db():
    with get_connection() as conn:
        with conn.cursor() as cursor:
            # جدول المشاريع
            cursor.execute('''
            CREATE TABLE IF NOT EXISTS projects (
                id SERIAL PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                description TEXT
            )
            ''')
            
            # جدول المعرفة
            cursor.execute('''
            CREATE TABLE IF NOT EXISTS knowledge (
                id SERIAL PRIMARY KEY,
                project_id INTEGER REFERENCES projects(id),
                content TEXT NOT NULL
            )
            ''')
            
            # جدول تاريخ المحادثات
            cursor.execute('''
            CREATE TABLE IF NOT EXISTS chat_history (
                id SERIAL PRIMARY KEY,
                project_id INTEGER REFERENCES projects(id),
                role TEXT,
                content TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            ''')
            
            # جدول حالة المستخدم
            cursor.execute('''
            CREATE TABLE IF NOT EXISTS user_state (
                user_id BIGINT PRIMARY KEY,
                current_project_id INTEGER REFERENCES projects(id)
            )
            ''')
            
            conn.commit()

def add_project(name, description=""):
    try:
        with get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute('INSERT INTO projects (name, description) VALUES (%s, %s) RETURNING id', (name, description))
                project_id = cursor.fetchone()[0]
                conn.commit()
                return project_id
    except Exception as e:
        print(f"Error adding project: {e}")
        return None

def get_projects():
    with get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute('SELECT id, name FROM projects')
            projects = cursor.fetchall()
            return projects

def set_user_project(user_id, project_id):
    with get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute('INSERT INTO user_state (user_id, current_project_id) VALUES (%s, %s) ON CONFLICT (user_id) DO UPDATE SET current_project_id = EXCLUDED.current_project_id', (user_id, project_id))
            conn.commit()

def get_user_project(user_id):
    with get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute('SELECT current_project_id FROM user_state WHERE user_id = %s', (user_id,))
            result = cursor.fetchone()
            return result[0] if result else None

def add_knowledge(project_id, content):
    with get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute('INSERT INTO knowledge (project_id, content) VALUES (%s, %s)', (project_id, content))
            conn.commit()

def get_project_knowledge(project_id):
    with get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute('SELECT content FROM knowledge WHERE project_id = %s', (project_id,))
            knowledge = cursor.fetchall()
            return [k[0] for k in knowledge]

def add_chat_history(project_id, role, content):
    with get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute('INSERT INTO chat_history (project_id, role, content) VALUES (%s, %s, %s)', (project_id, role, content))
            conn.commit()

def get_chat_history(project_id, limit=10):
    with get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute('SELECT role, content FROM chat_history WHERE project_id = %s ORDER BY timestamp DESC LIMIT %s', (project_id, limit))
            history = cursor.fetchall()
            return history[::-1]
