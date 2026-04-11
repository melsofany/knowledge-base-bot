import sqlite3

def init_db():
    conn = sqlite3.connect('knowledge.db')
    cursor = conn.cursor()
    
    # جدول المشاريع
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT
    )
    ''')
    
    # جدول المعرفة (التعليمات والبيانات)
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        content TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects (id)
    )
    ''')
    
    # جدول تاريخ المحادثات
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        role TEXT,
        content TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects (id)
    )
    ''')
    
    # جدول حالة المستخدم (المشروع الحالي المختار)
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS user_state (
        user_id INTEGER PRIMARY KEY,
        current_project_id INTEGER,
        FOREIGN KEY (current_project_id) REFERENCES projects (id)
    )
    ''')
    
    conn.commit()
    conn.close()

def add_project(name, description=""):
    conn = sqlite3.connect('knowledge.db')
    cursor = conn.cursor()
    try:
        cursor.execute('INSERT INTO projects (name, description) VALUES (?, ?)', (name, description))
        conn.commit()
        return cursor.lastrowid
    except sqlite3.IntegrityError:
        return None
    finally:
        conn.close()

def get_projects():
    conn = sqlite3.connect('knowledge.db')
    cursor = conn.cursor()
    cursor.execute('SELECT id, name FROM projects')
    projects = cursor.fetchall()
    conn.close()
    return projects

def set_user_project(user_id, project_id):
    conn = sqlite3.connect('knowledge.db')
    cursor = conn.cursor()
    cursor.execute('INSERT OR REPLACE INTO user_state (user_id, current_project_id) VALUES (?, ?)', (user_id, project_id))
    conn.commit()
    conn.close()

def get_user_project(user_id):
    conn = sqlite3.connect('knowledge.db')
    cursor = conn.cursor()
    cursor.execute('SELECT current_project_id FROM user_state WHERE user_id = ?', (user_id,))
    result = cursor.fetchone()
    conn.close()
    return result[0] if result else None

def add_knowledge(project_id, content):
    conn = sqlite3.connect('knowledge.db')
    cursor = conn.cursor()
    cursor.execute('INSERT INTO knowledge (project_id, content) VALUES (?, ?)', (project_id, content))
    conn.commit()
    conn.close()

def get_project_knowledge(project_id):
    conn = sqlite3.connect('knowledge.db')
    cursor = conn.cursor()
    cursor.execute('SELECT content FROM knowledge WHERE project_id = ?', (project_id,))
    knowledge = cursor.fetchall()
    conn.close()
    return [k[0] for k in knowledge]

def add_chat_history(project_id, role, content):
    conn = sqlite3.connect('knowledge.db')
    cursor = conn.cursor()
    cursor.execute('INSERT INTO chat_history (project_id, role, content) VALUES (?, ?, ?)', (project_id, role, content))
    conn.commit()
    conn.close()

def get_chat_history(project_id, limit=10):
    conn = sqlite3.connect('knowledge.db')
    cursor = conn.cursor()
    cursor.execute('SELECT role, content FROM chat_history WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?', (project_id, limit))
    history = cursor.fetchall()
    conn.close()
    return history[::-1]
