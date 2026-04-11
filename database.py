import psycopg
import os
import time
import logging
from psycopg_pool import ConnectionPool

# إعداد السجلات لمراقبة أخطاء قاعدة البيانات
logger = logging.getLogger(__name__)

# جلب رابط الاتصال بقاعدة البيانات من المتغيرات البيئية
DATABASE_URL = os.getenv('DATABASE_URL')

# تحسين رابط الاتصال لضمان استقرار SSL وتجنب الإغلاق المفاجئ
def get_optimized_url(url):
    if not url:
        # Fallback to local if no URL provided (for development)
        return "postgresql://postgres@localhost/postgres"
    
    # التأكد من وجود sslmode=require
    # في Render، يفضل استخدام sslmode=require مع gssencmode=disable
    params = []
    if "sslmode=" not in url:
        params.append("sslmode=require")
    
    if "gssencmode=" not in url:
        params.append("gssencmode=disable")
        
    if params:
        separator = "&" if "?" in url else "?"
        url += separator + "&".join(params)
    return url

OPTIMIZED_URL = get_optimized_url(DATABASE_URL)

# إنشاء تجمع اتصالات (Connection Pool) مع إعدادات أكثر استقراراً
# قمنا بتقليل min_size إلى 0 للسماح للتجمع بالبدء حتى لو فشل الاتصال الأولي
postgreSQL_pool = ConnectionPool(
    OPTIMIZED_URL,
    min_size=0,
    max_size=5,
    open=False,
    reconnect_failed=None,
    reconnect_timeout=5.0,
    kwargs={
        "connect_timeout": 15,
        "tcp_user_timeout": 15000,
    }
)

def get_connection():
    """الحصول على اتصال من التجمع مع التأكد من فتحه"""
    try:
        postgreSQL_pool.open()
    except Exception:
        pass
    
    # محاولة الحصول على اتصال مع إعادة المحاولة في حالة الفشل اللحظي
    max_retries = 3
    for i in range(max_retries):
        try:
            return postgreSQL_pool.connection()
        except Exception as e:
            if i == max_retries - 1:
                raise e
            time.sleep(2)

def init_db():
    """تهيئة جداول قاعدة البيانات مع آلية إعادة المحاولة"""
    print("جاري تهيئة قاعدة البيانات...")
    max_retries = 5
    for i in range(max_retries):
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
                    return
        except Exception as e:
            print(f"محاولة تهيئة قاعدة البيانات {i+1} فشلت: {e}")
            if i < max_retries - 1:
                time.sleep(5)
            else:
                print("فشلت جميع محاولات تهيئة قاعدة البيانات.")

def add_project(name, description=""):
    try:
        with get_connection() as conn:
            with conn.cursor() as cursor:
                # التحقق من وجود المشروع مسبقاً
                cursor.execute('SELECT id FROM projects WHERE LOWER(TRIM(name)) = LOWER(TRIM(%s))', (name,))
                existing = cursor.fetchone()
                if existing:
                    logger.info(f"Project '{name}' already exists with ID {existing[0]}")
                    return None
                
                cursor.execute('INSERT INTO projects (name, description) VALUES (%s, %s) RETURNING id', (name, description))
                project_id = cursor.fetchone()[0]
                conn.commit()
                return project_id
    except Exception as e:
        logger.error(f"Error adding project with pool: {e}")
        # محاولة إضافية بدون استخدام التجمع في حالة فشله
        try:
            # التأكد من أن الرابط محسن قبل استخدامه مباشرة
            direct_url = get_optimized_url(os.getenv('DATABASE_URL'))
            with psycopg.connect(direct_url, connect_timeout=10) as conn:
                with conn.cursor() as cursor:
                    # التحقق من وجود المشروع مسبقاً في المحاولة الثانية أيضاً
                    cursor.execute('SELECT id FROM projects WHERE LOWER(TRIM(name)) = LOWER(TRIM(%s))', (name,))
                    existing = cursor.fetchone()
                    if existing:
                        return None
                        
                    cursor.execute('INSERT INTO projects (name, description) VALUES (%s, %s) RETURNING id', (name, description))
                    project_id = cursor.fetchone()[0]
                    conn.commit()
                    return project_id
        except Exception as e2:
            logger.error(f"Fallback direct connection failed: {e2}")
            return None

def get_projects():
    try:
        with get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute('SELECT id, name FROM projects ORDER BY id DESC')
                projects = cursor.fetchall()
                return projects
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
                cursor.execute('INSERT INTO user_state (user_id, current_project_id) VALUES (%s, %s) ON CONFLICT (user_id) DO UPDATE SET current_project_id = EXCLUDED.current_project_id', (user_id, project_id))
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
