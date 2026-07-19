import os
import math
import datetime
import urllib.request
import urllib.parse
import json

OPENWEATHER_KEY = os.environ.get("OPENWEATHER_KEY", "")

# ── Live weather from OpenWeatherMap (free, no card) ──────────
def get_live_weather(lat, lng):
    """
    Fetches current weather for GPS coords.
    Free tier: 1000 calls/day — get key at openweathermap.org (no card needed).
    """
    if not OPENWEATHER_KEY or lat is None or lng is None:
        return None
    try:
        params = urllib.parse.urlencode({
            "lat": lat, "lon": lng,
            "appid": OPENWEATHER_KEY, "units": "metric"
        })
        url = f"https://api.openweathermap.org/data/2.5/weather?{params}"
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode())
        main = data["weather"][0]["main"].lower()
        mapping = {
            "thunderstorm": "storm", "drizzle": "rain",
            "rain": "rain",         "snow": "fog",
            "mist": "fog",          "fog": "fog",
            "haze": "fog",          "clouds": "cloudy",
            "clear": "clear",
        }
        return mapping.get(main, "clear")
    except Exception as e:
        print(f"[Weather API error] {e}")
        return None


# ── Severity predictor ────────────────────────────────────────
def predict_accident_severity(speed=0, weather="clear", road_type="urban", time_of_day=12):
    """Rule-based severity predictor. Returns: Minor / Moderate / Severe"""
    score = 0

    if speed > 80:       score += 3
    elif speed > 50:     score += 2
    else:                score += 1

    if weather.lower() in ["rain", "fog", "storm"]:   score += 2
    elif weather.lower() in ["cloudy", "windy"]:       score += 1

    if road_type.lower() == "highway":   score += 2
    elif road_type.lower() == "rural":   score += 1

    if 0 <= int(time_of_day) <= 5:        score += 2
    elif 20 <= int(time_of_day) <= 23:    score += 1

    if score >= 7:    return "Severe"
    elif score >= 4:  return "Moderate"
    else:             return "Minor"


def get_severity_color(severity):
    return {"Minor": "green", "Moderate": "orange", "Severe": "red"}.get(severity, "gray")


# ── Blackspot auto-detection ──────────────────────────────────
def detect_blackspots(reports, radius_km=0.3, min_reports=2):
    """
    Clusters hazard reports by GPS proximity.
    Any cluster with min_reports+ within radius_km = blackspot.
    Returns list of {lat, lng, count, types}.
    """
    def dist(r1, r2):
        if not all([r1.get('latitude'), r1.get('longitude'),
                    r2.get('latitude'), r2.get('longitude')]):
            return 999
        R = 6371
        d_lat = math.radians(r2['latitude']  - r1['latitude'])
        d_lng = math.radians(r2['longitude'] - r1['longitude'])
        a = (math.sin(d_lat/2)**2 +
             math.cos(math.radians(r1['latitude'])) *
             math.cos(math.radians(r2['latitude'])) *
             math.sin(d_lng/2)**2)
        return R * 2 * math.asin(math.sqrt(a))

    visited    = set()
    blackspots = []

    for i, r in enumerate(reports):
        if i in visited or not r.get('latitude'):
            continue
        cluster = [r]
        for j, r2 in enumerate(reports):
            if j != i and j not in visited and dist(r, r2) <= radius_km:
                cluster.append(r2)
        if len(cluster) >= min_reports:
            for j, rep in enumerate(reports):
                if rep in cluster:
                    visited.add(j)
            avg_lat = sum(c['latitude']  for c in cluster) / len(cluster)
            avg_lng = sum(c['longitude'] for c in cluster) / len(cluster)
            blackspots.append({
                "lat":   avg_lat,
                "lng":   avg_lng,
                "count": len(cluster),
                "types": list(set(c['hazard_type'] for c in cluster))
            })

    return blackspots


# ── Time-based risk prediction ────────────────────────────────
def predict_current_risk(sos_count, hazard_count, hour=None):
    """Predicts current risk level based on time, SOS and hazard counts."""
    if hour is None:
        hour = datetime.datetime.now().hour

    score = 0
    if 0 <= hour <= 5:                     score += 3
    elif 20 <= hour <= 23:                 score += 2
    elif hour in [7, 8, 9, 17, 18, 19]:   score += 1  # rush hours

    score += min(sos_count * 2, 6)
    score += min(hazard_count, 4)

    if score >= 8:    return "CRITICAL"
    elif score >= 5:  return "HIGH"
    elif score >= 2:  return "MODERATE"
    else:             return "LOW"
