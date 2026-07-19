import sqlite3

DB_PATH = 'resqnet.db'

def init_db():
    conn   = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Users table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            name              TEXT    NOT NULL,
            phone             TEXT,
            email             TEXT    UNIQUE NOT NULL,
            password          TEXT    NOT NULL,
            emergency_contact TEXT,
            role              TEXT    DEFAULT 'user',
            created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Hazard reports table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS hazard_reports (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            hazard_type TEXT    NOT NULL,
            location    TEXT    NOT NULL,
            latitude    REAL,
            longitude   REAL,
            photo_path  TEXT,
            status      TEXT    DEFAULT 'open',
            user_id     INTEGER,
            timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Emergency SOS logs table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS emergency_logs (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            status    TEXT    NOT NULL,
            latitude  REAL,
            longitude REAL,
            user_id   INTEGER,
            resolved  INTEGER DEFAULT 0,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Safe migrations for existing databases
    migrations = [
        "ALTER TABLE hazard_reports ADD COLUMN latitude    REAL",
        "ALTER TABLE hazard_reports ADD COLUMN longitude   REAL",
        "ALTER TABLE hazard_reports ADD COLUMN photo_path  TEXT",
        "ALTER TABLE hazard_reports ADD COLUMN status      TEXT DEFAULT 'open'",
        "ALTER TABLE hazard_reports ADD COLUMN user_id     INTEGER",
        "ALTER TABLE emergency_logs ADD COLUMN user_id     INTEGER",
        "ALTER TABLE emergency_logs ADD COLUMN resolved    INTEGER DEFAULT 0",
    ]
    for m in migrations:
        try:
            cursor.execute(m)
        except Exception:
            pass  # Column already exists
    # Live tracking table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS live_tracking (
            track_id   TEXT PRIMARY KEY,
            latitude   REAL,
            longitude  REAL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    conn.commit()
    conn.close()
    print("✅ Database initialized.")

def get_db():
    conn             = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn
