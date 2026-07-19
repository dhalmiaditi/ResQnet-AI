import hashlib
import base64
import os
import json
import time
from backend.database import get_db

# ── Password hashing ─────────────────────────────────────────
def hash_password(password):
    salt = os.urandom(16).hex()
    hashed = hashlib.sha256((salt + password).encode()).hexdigest()
    return f"{salt}:{hashed}"

def verify_password(password, stored):
    try:
        salt, hashed = stored.split(":")
        return hashlib.sha256((salt + password).encode()).hexdigest() == hashed
    except Exception:
        return False

# ── Simple token system (no extra libraries needed) ──────────
def generate_token(user_id, role):
    payload = json.dumps({"user_id": user_id, "role": role, "exp": time.time() + 86400})
    token   = hashlib.sha256((payload + os.environ.get("SECRET_KEY", "resqnet")).encode()).hexdigest()
    return f"{base64.b64encode(payload.encode()).decode()}.{token}"

def verify_token(token):
    try:
        parts   = token.split(".")
        payload = json.loads(base64.b64decode(parts[0]).decode())
        if payload["exp"] < time.time():
            return None
        expected = hashlib.sha256(
            (json.dumps(payload) + os.environ.get("SECRET_KEY", "resqnet")).encode()
        ).hexdigest()
        if parts[1] != expected:
            return None
        return payload
    except Exception:
        return None

# ── Register user ─────────────────────────────────────────────
def register_user(name, email, password, phone=None, emergency_contact=None):
    conn = get_db()
    existing = conn.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
    if existing:
        conn.close()
        return {"status": "error", "message": "Email already registered."}
    hashed = hash_password(password)
    conn.execute(
        "INSERT INTO users (name, email, password, phone, emergency_contact) VALUES (?,?,?,?,?)",
        (name, email, hashed, phone, emergency_contact)
    )
    conn.commit()
    user = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    conn.close()
    token = generate_token(user["id"], user["role"])
    return {"status": "success", "token": token, "name": name, "role": user["role"]}

# ── Login user ────────────────────────────────────────────────
def login_user(email, password):
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    conn.close()
    if not user or not verify_password(password, user["password"]):
        return {"status": "error", "message": "Invalid email or password."}
    token = generate_token(user["id"], user["role"])
    return {
        "status": "success",
        "token":  token,
        "name":   user["name"],
        "role":   user["role"],
        "phone":  user["phone"],
        "emergency_contact": user["emergency_contact"],
    }

# ── Get user from request token ───────────────────────────────
def get_current_user(request):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    payload = verify_token(auth[7:])
    if not payload:
        return None
    conn  = get_db()
    user  = conn.execute("SELECT * FROM users WHERE id=?", (payload["user_id"],)).fetchone()
    conn.close()
    return dict(user) if user else None
