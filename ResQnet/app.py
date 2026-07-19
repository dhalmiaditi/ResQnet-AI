from dotenv import load_dotenv
load_dotenv()

from flask import Flask
from flask_socketio import SocketIO
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from backend.routes import register_routes
from backend.database import init_db

app = Flask(__name__, template_folder='frontend', static_folder='frontend/static')
app.config['SECRET_KEY']          = 'resqnet-secret-change-in-production'
app.config['UPLOAD_FOLDER']       = 'frontend/static/uploads'
app.config['MAX_CONTENT_LENGTH']  = 5 * 1024 * 1024  # 5MB max photo upload

socketio = SocketIO(app, cors_allowed_origins="*")
limiter  = Limiter(get_remote_address, app=app, default_limits=["200 per day", "50 per hour"])

init_db()
register_routes(app, socketio, limiter)

if __name__ == '__main__':
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)
