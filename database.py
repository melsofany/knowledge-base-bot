import psycopg2
import os
from psycopg2 import pool

# جلب رابط الاتصال بقاعدة البيانات من المتغيرات البيئية
DATABASE_URL = os.getenv('DATABASE_URL')

# إنشاء تجمع اتصالات (Connection Pool)
try:
    postgreSQL_pool = psycopg2.pool.SimpleConnectionPool(1, 20, DATABASE_URL)
    if postgreSQL_pool:
        print("تم إنشاء تجمع الاتصالات بنجاح")
except Exception as e:
    print(f"خطأ في إنشاء تجمع الاتصالات: {e}")

def get_connection():
    return postgreSQL_pool.getconn()

def release_connection(conn):
    postgreSQL_pool.putconn(conn)

def init_db():
    conn = get_connection()
    cursor = conn.cursor()
    
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
    cursor.close()
    release_connection(conn)

def add_project(name, description=""):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute('INSERT INTO projects (name, description) VALUES (%s, %s) RETURNING id', (name, description))
        project_id = cursor.fetchone()[0]
        conn.commit()
        return project_id
    except Exception as e:
        print(f"Error adding project: {e}")
        conn.rollback()
        return None
    finally:
        cursor.close()
        release_connection(conn)

def get_projects():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT id, name FROM projects')
    projects = cursor.fetchall()
    cursor.close()
    release_connection(conn)
    return projects

def set_user_project(user_id, project_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('INSERT INTO user_state (user_id, current_project_id) VALUES (%s, %s) ON CONFLICT (user_id) DO UPDATE SET current_project_id = EXCLUDED.current_project_id', (user_id, project_id))
    conn.commit()
    cursor.close()
    release_connection(conn)

def get_user_project(user_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT current_project_id FROM user_state WHERE user_id = %s', (user_id,))
    result = cursor.fetchone()
    cursor.close()
    release_connection(conn)
    return result[0] if result else None

def add_knowledge(project_id, content):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('INSERT INTO knowledge (project_id, content) VALUES (%s, %s)', (project_id, content))
    conn.commit()
    cursor.close()
    release_connection(conn)

def get_project_knowledge(project_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT content FROM knowledge WHERE project_id = %s', (project_id,))
    knowledge = cursor.fetchall()
    cursor.close()
    release_connection(conn)
    return [k[0] for k in knowledge]

def add_chat_history(project_id, role, content):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('INSERT INTO chat_history (project_id, role, content) VALUES (%s, %s, %s)', (project_id, role, content))
    conn.commit()
    cursor.close()
    release_connection(conn)

def get_chat_history(project_id, limit=10):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT role, content FROM chat_history WHERE project_id = %s ORDER BY timestamp DESC LIMIT %s', (project_id, limit))
    history = cursor.fetchall()
    cursor.close()
    release_connection(conn)
    return history[::-1]
