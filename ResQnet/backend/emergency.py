import os
import math
import urllib.request
import urllib.parse
import json

def _haversine(lat1, lng1, lat2, lng2):
    R = 6371
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = (math.sin(d_lat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(d_lng / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(a))

def _eta_minutes(distance_km, speed_kmh=40):
    minutes = (distance_km / speed_kmh) * 60
    return f"{max(1, round(minutes))} mins"

def _overpass_query(lat, lng, amenity, radius=5000, max_results=3):
    query = f"""
    [out:json][timeout:10];
    (
      node["amenity"="{amenity}"](around:{radius},{lat},{lng});
      way["amenity"="{amenity}"](around:{radius},{lat},{lng});
    );
    out center {max_results * 3};
    """
    url  = "https://overpass-api.de/api/interpreter"
    data = urllib.parse.urlencode({"data": query}).encode()
    try:
        req = urllib.request.Request(url, data=data, method="POST")
        req.add_header("User-Agent", "ResQNet-Emergency-App/1.0")
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode())
    except Exception as e:
        print(f"[Overpass API error] {e}")
        return []

    places = []
    for element in result.get("elements", []):
        if element["type"] == "node":
            p_lat, p_lng = element["lat"], element["lon"]
        elif element["type"] == "way" and "center" in element:
            p_lat, p_lng = element["center"]["lat"], element["center"]["lon"]
        else:
            continue
        tags  = element.get("tags", {})
        name  = (tags.get("name") or tags.get("name:en") or
                 tags.get("operator") or amenity.replace("_", " ").title())
        phone = (tags.get("phone") or tags.get("contact:phone") or
                 tags.get("emergency:phone"))
        dist  = _haversine(lat, lng, p_lat, p_lng)
        places.append({
            "name": name, "distance_km": round(dist, 2),
            "distance": f"{dist:.1f} km",
            "lat": p_lat, "lng": p_lng, "phone": phone,
        })
    places.sort(key=lambda x: x["distance_km"])
    return places[:max_results]

def _fallback_services():
    return {
        "hospitals": [{"name": "Call 104 Health Helpline", "distance": "GPS needed", "phone": "104"}],
        "ambulance": [
            {"name": "108 Ambulance Service", "eta": "Call 108"},
            {"name": "112 Emergency Response", "eta": "Call 112"},
        ],
        "police": [{"name": "Call 100 Police Helpline", "distance": "GPS needed", "phone": "100"}],
        "source": "fallback",
    }

def get_nearby_services(lat=None, lng=None):
    """
    Returns real nearby emergency services using OpenStreetMap (Overpass API).
    100% free — no API key, no card, no signup needed.
    """
    if lat is None or lng is None:
        return _fallback_services()

    hospitals_raw = _overpass_query(lat, lng, "hospital", radius=8000, max_results=3)
    if not hospitals_raw:
        hospitals_raw = _overpass_query(lat, lng, "clinic", radius=5000, max_results=3)
    police_raw = _overpass_query(lat, lng, "police", radius=6000, max_results=2)

    hospitals = [{
        "name": h["name"], "distance": h["distance"],
        "phone": h["phone"] or "104", "lat": h["lat"], "lng": h["lng"],
    } for h in hospitals_raw]

    ambulance = [
        {"name": "108 Ambulance Service",
         "eta": _eta_minutes(hospitals_raw[0]["distance_km"]) if hospitals_raw else "Call 108"},
        {"name": "112 Emergency Response", "eta": "Priority dispatch"},
    ]

    police = [{
        "name": p["name"], "distance": p["distance"],
        "phone": p["phone"] or "100", "lat": p["lat"], "lng": p["lng"],
    } for p in police_raw]

    if not police:
        police.append({"name": "Tamil Nadu Police", "distance": "Call directly", "phone": "100"})

    return {
        "hospitals": hospitals,
        "ambulance": ambulance,
        "police":    police,
        "source":    "openstreetmap",
        "user_location": {"lat": lat, "lng": lng},
    }
