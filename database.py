import psycopg2
import os
import time
import logging

# إعداد السجلات
logger = logging.getLogger(__name__)

# جلب رابط الاتصال بقاعدة البيانات
DATABASE_URL = os.getenv('DATABASE_URL')

def get_connection():
    """الحصول على اتصال مباشر بقاعدة البيانات مع دعم SSL شامل"""
    if not DATABASE_URL:
        # Fallback for local development
        return psycopg2.connect("postgresql://postgres@localhost/postgres")
    
    # محاولة الاتصال مع إعادة المحاولة في حالة الفشل
    max_retries = 3
    for i in range(max_retries):
        try:
            # استخدام sslmode=require بشكل صريح لضمان التوافق مع Render/Google Cloud
            # psycopg2 يتعامل مع SSL بشكل أكثر استقراراً في البيئات السحابية
            conn = psycopg2.connect(DATABASE_URL, sslmode='require', connect_timeout=10)
            return conn
        except Exception as e:
            logger.error(f"Attempt {i+1} to connect failed: {e}")
            if i < max_retries - 1:
                time.sleep(2)
            else:
                raise e

def init_db():
    """تهيئة جداول قاعدة البيانات"""
    print("جاري تهيئة قاعدة البيانات...")
    try:
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
                    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
                    content TEXT NOT NULL
                )
                ''')
                
                # جدول تاريخ المحادثات
                cursor.execute('''
                CREATE TABLE IF NOT EXISTS chat_history (
                    id SERIAL PRIMARY KEY,
                    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
                    role TEXT,
                    content TEXT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                ''')
                
                # جدول حالة المستخدم
                cursor.execute('''
                CREATE TABLE IF NOT EXISTS user_state (
                    user_id BIGINT PRIMARY KEY,
                    current_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL
                )
                ''')
                
                conn.commit()
                print("تمت تهيئة قاعدة البيانات بنجاح")
    except Exception as e:
        print(f"فشل تهيئة قاعدة البيانات: {e}")

def add_project(name, description=""):
    try:
        with get_connection() as conn:
            with conn.cursor() as cursor:
                # التحقق من وجود المشروع مسبقاً (Case-insensitive)
                cursor.execute('SELECT id FROM projects WHERE LOWER(TRIM(name)) = LOWER(TRIM(%s))', (name,))
                existing = cursor.fetchone()
                if existing:
                    return None
                
                cursor.execute('INSERT INTO projects (name, description) VALUES (%s, %s) RETURNING id', (name, description))
                project_id = cursor.fetchone()[0]
                conn.commit()
                return project_id
    except Exception as e:
        logger.error(f"Error adding project: {e}")
        return None

def get_projects():
    try:
        with get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute('SELECT id, name FROM projects ORDER BY id DESC')
                return cursor.fetchall()
    except Exception as e:
        logger.error(f"Error getting projects: {e}")
        return []

def get_project_by_name(name):
    try:
        with get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute('SELECT id, name FROM projects WHERE LOWER(TRIM(name)) = LOWER(TRIM(%s))', (name,))
                return cursor.fetchone()
    except Exception as e:
        logger.error(f"Error getting project by name: {e}")
        return None

def set_user_project(user_id, project_id):
    try:
        with get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute('''
                    INSERT INTO user_state (user_id, current_project_id) 
                    VALUES (%s, %s) 
                    ON CONFLICT (user_id) 
                    DO UPDATE SET current_project_id = EXCLUDED.current_project_id
                ''', (user_id, project_id))
                conn.commit()
    except Exception as e:
        logger.error(f"Error setting user project: {e}")

def get_user_project(user_id):
    try:
        with get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute('SELECT current_project_id FROM user_state WHERE user_id = %s', (user_id,))
                result = cursor.fetchone()
                return result[0] if result else None
    except Exception as e:
        logger.error(f"Error getting user project: {e}")
        return None

def add_knowledge(project_id, content):
    try:
        with get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute('INSERT INTO knowledge (project_id, content) VALUES (%s, %s)', (project_id, content))
                conn.commit()
    except Exception as e:
        logger.error(f"Error adding knowledge: {e}")

def get_project_knowledge(project_id):
    try:
        with get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute('SELECT content FROM knowledge WHERE project_id = %s', (project_id,))
                knowledge = cursor.fetchall()
                return [k[0] for k in knowledge]
    except Exception as e:
        logger.error(f"Error getting knowledge: {e}")
        return []

def add_chat_history(project_id, role, content):
    try:
        with get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute('INSERT INTO chat_history (project_id, role, content) VALUES (%s, %s, %s)', (project_id, role, content))
                conn.commit()
    except Exception as e:
        logger.error(f"Error adding chat history: {e}")

def get_chat_history(project_id, limit=10):
    try:
        with get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute('SELECT role, content FROM chat_history WHERE project_id = %s ORDER BY timestamp DESC LIMIT %s', (project_id, limit))
                history = cursor.fetchall()
                return history[::-1]
    except Exception as e:
        logger.error(f"Error getting chat history: {e}")
        return []
