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
        return url
    
    # التأكد من وجود sslmode=require
    params = []
    if "sslmode=" not in url:
        params.append("sslmode=require")
    
    # إضافة gssencmode=disable لتجنب مشاكل GSSAPI في بعض البيئات
    if "gssencmode=" not in url:
        params.append("gssencmode=disable")
        
    if params:
        separator = "&" if "?" in url else "?"
        url += separator + "&".join(params)
    return url

OPTIMIZED_URL = get_optimized_url(DATABASE_URL)

# إنشاء تجمع اتصالات (Connection Pool) مع إعدادات أكثر استقراراً
# ملاحظة: في psycopg-pool، لا توجد خاصية .opened أو .opened_
# بدلاً من ذلك، نستخدم open() ونعالج الاستثناء إذا كان مفتوحاً بالفعل، أو نتركه يفتح تلقائياً عند الحاجة
postgreSQL_pool = ConnectionPool(
    OPTIMIZED_URL,
    min_size=1,
    max_size=10,
    open=False, # لا تفتح الاتصال فوراً عند الاستيراد
    reconnect_failed=None,
    reconnect_timeout=5.0,
    kwargs={
        "connect_timeout": 10,
    }
)

def get_connection():
    """الحصول على اتصال من التجمع مع التأكد من فتحه"""
    try:
        # في الإصدارات الحديثة، استدعاء open() آمن حتى لو كان مفتوحاً
        # أو يمكننا ببساطة الاعتماد على أن التجمع سيفتح نفسه عند أول طلب اتصال إذا لم نغلقه
        postgreSQL_pool.open()
    except Exception as e:
        # إذا كان مفتوحاً بالفعل، قد يرمي استثناءً في بعض الإصدارات، نتجاهله
        pass
    
    return postgreSQL_pool.connection()

def init_db():
    """تهيئة جداول قاعدة البيانات مع آلية إعادة المحاولة"""
    print("جاري تهيئة قاعدة البيانات...")
    max_retries = 5
    for i in range(max_retries):
        try:
            # نستخدم context manager لضمان إغلاق الاتصال والكرسر
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
                    print("تمت تهيئة قاعدة البيانات بنجاح")
                    return
        except Exception as e:
            print(f"محاولة تهيئة قاعدة البيانات {i+1} فشلت: {e}")
            if i < max_retries - 1:
                time.sleep(3)
            else:
                print("فشلت جميع محاولات تهيئة قاعدة البيانات.")

def add_project(name, description=""):
    try:
        with get_connection() as conn:
            with conn.cursor() as cursor:
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
                cursor.execute('SELECT id, name FROM projects')
                projects = cursor.fetchall()
                return projects
    except Exception as e:
        logger.error(f"Error getting projects: {e}")
        return []

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
