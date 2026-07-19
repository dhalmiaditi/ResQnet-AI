import os
import datetime
from flask import render_template, request, jsonify, send_file, Response
from werkzeug.utils import secure_filename
from backend.database import get_db
from backend.ai_model import (predict_accident_severity, get_severity_color,
                               get_live_weather, detect_blackspots, predict_current_risk)
from backend.emergency import get_nearby_services
from backend.sms import send_sos_sms, send_hazard_sms
from backend.auth import register_user, login_user, get_current_user
from backend.export import export_csv, export_pdf
from backend.email_service import send_hazard_confirmation, send_hazard_resolved, send_sos_alert_email
import io
 
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp'}
 
def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS
 
 
def register_routes(app, socketio, limiter):
 
    # ── PAGE ROUTES ──────────────────────────────────────────
 
    @app.route('/')
    def home():
        return render_template('index.html')
 
    @app.route('/dashboard')
    def dashboard():
        return render_template('dashboard.html')
 
    @app.route('/sos')
    def sos_page():
        return render_template('sos.html')
 
    @app.route('/report')
    def report_page():
        return render_template('report.html')
 
    @app.route('/admin')
    def admin_page():
        return render_template('admin.html')
 
    @app.route('/login')
    def login_page():
        return render_template('login.html')
 
    @app.route('/track/<track_id>')
    def track_page(track_id):
        return render_template('track.html', track_id=track_id)

    @app.route('/womens_safety')
    def womens_safety_page():
        return render_template('womens_safety.html')
 
    # ── ICON ROUTES ──────────────────────────────────────────
 
    @app.route('/static/icons/icon-192.png')
    def icon_192():
        svg = '''<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192">
            <rect width="192" height="192" rx="40" fill="#0b0f1a"/>
            <circle cx="96" cy="96" r="80" fill="#cc0000"/>
            <text x="96" y="80" font-family="Arial" font-size="36" font-weight="bold"
                fill="white" text-anchor="middle">RQ</text>
            <text x="96" y="118" font-family="Arial" font-size="18"
                fill="white" text-anchor="middle">NET AI</text>
            <text x="96" y="150" font-family="Arial" font-size="28"
                fill="white" text-anchor="middle">🚨</text>
        </svg>'''
        return Response(svg, mimetype='image/svg+xml')
 
    @app.route('/static/icons/icon-512.png')
    def icon_512():
        svg = '''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
            <rect width="512" height="512" rx="100" fill="#0b0f1a"/>
            <circle cx="256" cy="256" r="220" fill="#cc0000"/>
            <text x="256" y="220" font-family="Arial" font-size="100" font-weight="bold"
                fill="white" text-anchor="middle">RQ</text>
            <text x="256" y="310" font-family="Arial" font-size="48"
                fill="white" text-anchor="middle">NET AI</text>
            <text x="256" y="400" font-family="Arial" font-size="80"
                fill="white" text-anchor="middle">🚨</text>
        </svg>'''
        return Response(svg, mimetype='image/svg+xml')
 
    # ── AUTH ROUTES ──────────────────────────────────────────
 
    @app.route('/api/auth/register', methods=['POST'])
    @limiter.limit("10 per hour")
    def register():
        data   = request.get_json()
        result = register_user(
            name=data.get('name', '').strip(),
            email=data.get('email', '').strip().lower(),
            password=data.get('password', ''),
            phone=data.get('phone', '').strip(),
            emergency_contact=data.get('emergency_contact', '').strip()
        )
        return jsonify(result), 200 if result['status'] == 'success' else 400
 
    @app.route('/api/auth/login', methods=['POST'])
    @limiter.limit("20 per hour")
    def login():
        data   = request.get_json()
        result = login_user(
            email=data.get('email', '').strip().lower(),
            password=data.get('password', '')
        )
        return jsonify(result), 200 if result['status'] == 'success' else 401
 
    # ── SOS ROUTE ────────────────────────────────────────────
 
    @app.route('/api/sos', methods=['POST'])
    @limiter.limit("5 per minute")
    def trigger_sos():
        data = request.get_json()
        lat  = data.get('latitude')
        lng  = data.get('longitude')
 
        try:
            lat = float(lat) if lat is not None else None
            lng = float(lng) if lng is not None else None
        except (ValueError, TypeError):
            lat, lng = None, None
 
        user    = get_current_user(request)
        user_id = user['id'] if user else None
 
        conn = get_db()
        conn.execute(
            "INSERT INTO emergency_logs (status, latitude, longitude, user_id) VALUES (?,?,?,?)",
            ("ACTIVE", lat, lng, user_id)
        )
        conn.commit()
 
        sos_count    = conn.execute("SELECT COUNT(*) FROM emergency_logs WHERE status='ACTIVE'").fetchone()[0]
        hazard_count = conn.execute("SELECT COUNT(*) FROM hazard_reports").fetchone()[0]
        conn.close()
 
        socketio.emit('stats_update', {
            'active_sos':     sos_count,
            'hazard_reports': hazard_count,
            'risk_level':     predict_current_risk(sos_count, hazard_count)
        })
 
        if user and user.get('emergency_contact'):
            send_sos_sms(
                phone_number=user['emergency_contact'],
                lat=lat, lng=lng,
                user_name=user['name']
            )
 
        # Send SOS email to emergency contact
        if user and user.get('email'):
            send_sos_alert_email(
                to_email  = user['email'],
                user_name = user['name'],
                lat       = lat,
                lng       = lng
            )
 
        services = get_nearby_services(lat=lat, lng=lng)
        return jsonify({
            "status":          "SOS_SENT",
            "message":         "Emergency services alerted!",
            "location":        {"lat": lat, "lng": lng},
            "nearby_services": services,
        })
 
    # ── LIVE TRACKING ROUTES ─────────────────────────────────
 
    @app.route('/api/track/update', methods=['POST'])
    def track_update():
        data     = request.get_json()
        track_id = data.get('track_id')
        lat      = data.get('latitude')
        lng      = data.get('longitude')
        if not track_id:
            return jsonify({"status": "error"}), 400
        conn = get_db()
        conn.execute(
            "INSERT OR REPLACE INTO live_tracking (track_id, latitude, longitude, updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)",
            (track_id, lat, lng)
        )
        conn.commit()
        conn.close()
        return jsonify({"status": "ok"})
 
    @app.route('/api/track/<track_id>')
    def track_get(track_id):
        conn = get_db()
        row  = conn.execute(
            "SELECT * FROM live_tracking WHERE track_id=?", (track_id,)
        ).fetchone()
        conn.close()
        if not row:
            return jsonify({"status": "not_found"}), 404
        return jsonify({
            "latitude":   row['latitude'],
            "longitude":  row['longitude'],
            "updated_at": row['updated_at']
        })
 
    # ── HAZARD REPORT ROUTE ──────────────────────────────────
 
    @app.route('/api/report', methods=['POST'])
    @limiter.limit("20 per hour")
    def submit_report():
        hazard_type = request.form.get('hazard_type', '').strip()
        location    = request.form.get('location', '').strip()
        lat         = request.form.get('latitude')
        lng         = request.form.get('longitude')
 
        if not hazard_type or not location:
            return jsonify({"status": "error", "message": "All fields are required."}), 400
 
        try:
            lat = float(lat) if lat else None
            lng = float(lng) if lng else None
        except (ValueError, TypeError):
            lat, lng = None, None
 
        photo_path = None
        if 'photo' in request.files:
            photo = request.files['photo']
            if photo and allowed_file(photo.filename):
                filename  = secure_filename(photo.filename)
                timestamp = datetime.datetime.now().strftime('%Y%m%d%H%M%S')
                filename  = f"{timestamp}_{filename}"
                save_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
                os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
                photo.save(save_path)
                photo_path = f"uploads/{filename}"
 
        user    = get_current_user(request)
        user_id = user['id'] if user else None
 
        conn = get_db()
        conn.execute(
            "INSERT INTO hazard_reports (hazard_type, location, latitude, longitude, photo_path, user_id) VALUES (?,?,?,?,?,?)",
            (hazard_type, location, lat, lng, photo_path, user_id)
        )
        conn.commit()
        hazard_count = conn.execute("SELECT COUNT(*) FROM hazard_reports").fetchone()[0]
        sos_count    = conn.execute("SELECT COUNT(*) FROM emergency_logs WHERE status='ACTIVE'").fetchone()[0]
        new_id       = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.close()
 
        # Send confirmation email
        if user and user.get('email'):
            send_hazard_confirmation(
                to_email    = user['email'],
                hazard_type = hazard_type,
                location    = location,
                report_id   = new_id
            )
 
        socketio.emit('stats_update', {
            'hazard_reports': hazard_count,
            'active_sos':     sos_count,
            'risk_level':     predict_current_risk(sos_count, hazard_count)
        })
 
        admin_phone = os.environ.get("ADMIN_PHONE", "")
        if admin_phone:
            send_hazard_sms(admin_phone, hazard_type, location)
 
        return jsonify({"status": "success", "message": "Hazard reported successfully!"})
 
    # ── PHOTO AI ANALYSIS ────────────────────────────────────
 
    @app.route('/api/analyze-photo', methods=['POST'])
    def analyze_photo():
        import base64, json as json_lib
        import requests as req
 
        if 'photo' not in request.files:
            return jsonify({"status": "error", "message": "No photo uploaded"}), 400
 
        photo      = request.files['photo']
        image_data = base64.b64encode(photo.read()).decode('utf-8')
        mime_type  = photo.mimetype or 'image/jpeg'
        api_key    = os.environ.get('GEMINI_API_KEY', '')
 
        if not api_key:
            return jsonify({
                "status":      "success",
                "hazard_type": "Road Damage",
                "severity":    "Moderate",
                "description": "API key not set. Please select hazard type manually."
            })
 
        try:
            response = req.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}",
                json={
                    "contents": [{
                        "parts": [
                            { "inline_data": { "mime_type": mime_type, "data": image_data } },
                            { "text": 'Analyze this road hazard image. Reply in JSON only, no markdown:\n{"hazard_type":"one of Pothole/Broken Signal/Flood Zone/Road Damage/Accident Spot/Other","severity":"Minor or Moderate or Severe","description":"one sentence"}' }
                        ]
                    }]
                },
                timeout=15
            )
            text = response.json()['candidates'][0]['content']['parts'][0]['text']
            text = text.replace('```json', '').replace('```', '').strip()
            data = json_lib.loads(text)
            return jsonify({"status": "success", **data})
 
        except Exception:
            return jsonify({
                "status":      "success",
                "hazard_type": "Road Damage",
                "severity":    "Moderate",
                "description": "Could not analyze. Please select hazard type manually."
            })
 
    # ── PREDICT ROUTE ────────────────────────────────────────
 
    @app.route('/api/predict', methods=['POST'])
    def predict():
        data = request.get_json()
        lat  = data.get('latitude')
        lng  = data.get('longitude')
 
        live_weather = get_live_weather(lat, lng) if lat and lng else None
        weather      = live_weather or data.get('weather', 'clear')
 
        severity = predict_accident_severity(
            speed=data.get('speed', 0),
            weather=weather,
            road_type=data.get('road_type', 'urban'),
            time_of_day=data.get('time_of_day', datetime.datetime.now().hour)
        )
        return jsonify({
            "severity":     severity,
            "color":        get_severity_color(severity),
            "weather_used": weather,
            "weather_live": live_weather is not None
        })
 
    # ── STATS ROUTE ──────────────────────────────────────────
 
    @app.route('/api/stats')
    def stats():
        conn         = get_db()
        hazard_count = conn.execute("SELECT COUNT(*) FROM hazard_reports").fetchone()[0]
        sos_count    = conn.execute("SELECT COUNT(*) FROM emergency_logs WHERE status='ACTIVE'").fetchone()[0]
        resolved     = conn.execute("SELECT COUNT(*) FROM emergency_logs WHERE resolved=1").fetchone()[0]
        conn.close()
        return jsonify({
            "hazard_reports": hazard_count,
            "active_sos":     sos_count,
            "resolved_sos":   resolved,
            "risk_level":     predict_current_risk(sos_count, hazard_count),
        })
 
    # ── REPORTS ROUTE ────────────────────────────────────────
 
    @app.route('/api/reports/all')
    def all_reports():
        conn = get_db()
        rows = conn.execute(
            "SELECT * FROM hazard_reports ORDER BY timestamp DESC LIMIT 20"
        ).fetchall()
        conn.close()
        return jsonify([dict(row) for row in rows])
 
    # ── REPORTS TIMELINE ─────────────────────────────────────
 
    @app.route('/api/reports/timeline')
    def reports_timeline():
        conn = get_db()
        rows = conn.execute(
            "SELECT * FROM hazard_reports ORDER BY timestamp DESC LIMIT 50"
        ).fetchall()
        conn.close()
        return jsonify([dict(r) for r in rows])
 
    # ── HEATMAP ROUTE ────────────────────────────────────────
 
    @app.route('/api/heatmap')
    def heatmap_data():
        try:
            conn   = get_db()
            rows   = conn.execute(
                "SELECT latitude, longitude FROM hazard_reports WHERE latitude IS NOT NULL AND longitude IS NOT NULL"
            ).fetchall()
            conn.close()
            points = [[float(row['latitude']), float(row['longitude']), 1.0] for row in rows]
        except Exception:
            points = []
        return jsonify(points)
 
    # ── BLACKSPOTS ROUTE ─────────────────────────────────────
 
    @app.route('/api/blackspots')
    def blackspots():
        conn    = get_db()
        rows    = conn.execute(
            "SELECT hazard_type, latitude, longitude FROM hazard_reports WHERE latitude IS NOT NULL"
        ).fetchall()
        conn.close()
        reports = [dict(r) for r in rows]
        spots   = detect_blackspots(reports)
        return jsonify(spots)
 
    # ── ROUTE RISK SCORE ─────────────────────────────────────
 
    @app.route('/api/route-risk', methods=['POST'])
    def route_risk():
        import requests as req
        data        = request.get_json()
        source      = data.get('source', '')
        destination = data.get('destination', '')
 
        if not source or not destination:
            return jsonify({"status": "error", "message": "Source and destination required"}), 400
 
        def geocode(place):
            try:
                r = req.get(
                    'https://nominatim.openstreetmap.org/search',
                    params={'q': place, 'format': 'json', 'limit': 1},
                    headers={'User-Agent': 'ResQNetAI/1.0'},
                    timeout=10
                )
                results = r.json()
                if results:
                    return float(results[0]['lat']), float(results[0]['lon'])
            except Exception:
                pass
            return None, None
 
        src_lat, src_lng = geocode(source)
        dst_lat, dst_lng = geocode(destination)
 
        if not src_lat or not dst_lat:
            return jsonify({"status": "error", "message": "Could not find locations. Try adding city name."}), 400
 
        ors_key      = os.environ.get('ORS_API_KEY', '')
        route_coords = []
 
        if ors_key:
            try:
                r = req.post(
                    'https://api.openrouteservice.org/v2/directions/driving-car/geojson',
                    json={"coordinates": [[src_lng, src_lat], [dst_lng, dst_lat]]},
                    headers={'Authorization': ors_key, 'Content-Type': 'application/json'},
                    timeout=10
                )
                route_coords = r.json()['features'][0]['geometry']['coordinates']
            except Exception:
                pass
 
        conn    = get_db()
        hazards = conn.execute(
            "SELECT latitude, longitude, hazard_type FROM hazard_reports WHERE latitude IS NOT NULL"
        ).fetchall()
        conn.close()
 
        def point_near_route(hlat, hlng, coords, threshold=0.01):
            for lng, lat in coords:
                if abs(lat - hlat) < threshold and abs(lng - hlng) < threshold:
                    return True
            return False
 
        risk_score   = 0
        risk_spots   = []
        simple_line  = [[src_lng, src_lat], [dst_lng, dst_lat]]
        check_coords = route_coords if route_coords else simple_line
 
        for h in hazards:
            if point_near_route(h['latitude'], h['longitude'], check_coords):
                risk_score += 1
                risk_spots.append({"lat": h['latitude'], "lng": h['longitude'], "type": h['hazard_type']})
 
        if risk_score >= 5:
            risk_level, risk_color = "HIGH",     "red"
            advice = "⚠️ High risk route! Many hazards detected. Consider an alternative path."
        elif risk_score >= 2:
            risk_level, risk_color = "MODERATE", "orange"
            advice = "⚠️ Moderate risk. Drive carefully and watch for road hazards."
        else:
            risk_level, risk_color = "LOW",      "green"
            advice = "✅ Route looks relatively safe. Drive carefully."
 
        return jsonify({
            "status":       "success",
            "source":       source,
            "destination":  destination,
            "src_coords":   {"lat": src_lat, "lng": src_lng},
            "dst_coords":   {"lat": dst_lat, "lng": dst_lng},
            "risk_score":   risk_score,
            "risk_level":   risk_level,
            "risk_color":   risk_color,
            "advice":       advice,
            "risk_spots":   risk_spots,
            "route_coords": route_coords
        })
 
    # ── ADMIN ROUTES ─────────────────────────────────────────
 
    def require_admin(req):
        user = get_current_user(req)
        if not user:
            return None, (jsonify({"status": "error", "message": "Authentication required."}), 401)
        if user.get("role") != "admin":
            return None, (jsonify({"status": "error", "message": "Admin access required."}), 403)
        return user, None
 
    @app.route('/api/admin/sos')
    def admin_sos():
        _, err = require_admin(request)
        if err: return err
        conn = get_db()
        rows = conn.execute("SELECT * FROM emergency_logs ORDER BY timestamp DESC").fetchall()
        conn.close()
        return jsonify([dict(r) for r in rows])
 
    @app.route('/api/admin/resolve/<int:log_id>', methods=['POST'])
    def resolve_sos(log_id):
        _, err = require_admin(request)
        if err: return err
        conn = get_db()
        conn.execute("UPDATE emergency_logs SET resolved=1, status='RESOLVED' WHERE id=?", (log_id,))
        conn.commit()
        conn.close()
        socketio.emit('sos_resolved', {'id': log_id})
        return jsonify({"status": "success"})
 
    @app.route('/api/admin/close_report/<int:report_id>', methods=['POST'])
    def close_report(report_id):
        _, err = require_admin(request)
        if err: return err
        conn = get_db()
        conn.execute("UPDATE hazard_reports SET status='resolved' WHERE id=?", (report_id,))
        conn.commit()
        conn.close()
        return jsonify({"status": "success"})
 
    # ── ROLE MANAGEMENT ──────────────────────────────────────
 
    @app.route('/api/admin/users')
    def admin_users():
        _, err = require_admin(request)
        if err: return err
        conn = get_db()
        rows = conn.execute(
            "SELECT id, name, email, phone, role, created_at FROM users ORDER BY created_at DESC"
        ).fetchall()
        conn.close()
        return jsonify([dict(r) for r in rows])
 
    @app.route('/api/admin/promote/<int:user_id>', methods=['POST'])
    def promote_user(user_id):
        _, err = require_admin(request)
        if err: return err
        conn = get_db()
        conn.execute("UPDATE users SET role='admin' WHERE id=?", (user_id,))
        conn.commit()
        conn.close()
        return jsonify({"status": "success", "message": "User promoted to admin"})
 
    @app.route('/api/admin/demote/<int:user_id>', methods=['POST'])
    def demote_user(user_id):
        _, err = require_admin(request)
        if err: return err
        conn = get_db()
        conn.execute("UPDATE users SET role='user' WHERE id=?", (user_id,))
        conn.commit()
        conn.close()
        return jsonify({"status": "success", "message": "User demoted to user"})
 
    # ── HAZARD STATUS TIMELINE ───────────────────────────────
 
    @app.route('/api/admin/update-status/<int:report_id>', methods=['POST'])
    def update_hazard_status(report_id):
        _, err = require_admin(request)
        if err: return err
        data   = request.get_json()
        status = data.get('status', 'open')
        if status not in ['open', 'investigating', 'resolved']:
            return jsonify({"status": "error", "message": "Invalid status"}), 400
 
        conn   = get_db()
        report = conn.execute(
            "SELECT hr.*, u.email FROM hazard_reports hr LEFT JOIN users u ON hr.user_id=u.id WHERE hr.id=?",
            (report_id,)
        ).fetchone()
        conn.execute("UPDATE hazard_reports SET status=? WHERE id=?", (status, report_id))
        conn.commit()
        conn.close()
 
        if status == 'resolved' and report and report['email']:
            send_hazard_resolved(
                to_email    = report['email'],
                hazard_type = report['hazard_type'],
                location    = report['location'],
                report_id   = report_id
            )
 
        return jsonify({"status": "success", "message": f"Report {report_id} marked as {status}"})
 
    # ── EXPORT ROUTES ────────────────────────────────────────
 
    @app.route('/api/export/csv')
    def export_csv_route():
        csv_data = export_csv()
        return Response(
            csv_data,
            mimetype='text/csv',
            headers={"Content-Disposition": "attachment; filename=resqnet_reports.csv"}
        )
 
    @app.route('/api/export/pdf')
    def export_pdf_route():
        pdf_data = export_pdf()
        return send_file(
            io.BytesIO(pdf_data),
            mimetype='application/pdf',
            as_attachment=True,
            download_name='resqnet_report.pdf'
        )
 