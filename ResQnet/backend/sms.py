import os
import urllib.request
import urllib.parse
import json

FAST2SMS_KEY = os.environ.get("FAST2SMS_KEY", "")

def send_sos_sms(phone_number, lat, lng, user_name="Someone"):
    """
    Sends a real SMS via Fast2SMS (free Indian SMS API — no card needed).
    Get free API key at: https://www.fast2sms.com
    Free tier: 200 SMS credits on signup.

    Args:
        phone_number: 10-digit Indian mobile number of emergency contact
        lat, lng: GPS coordinates
        user_name: Name of the person sending SOS
    """
    if not FAST2SMS_KEY:
        print("[SMS] FAST2SMS_KEY not set — skipping SMS")
        return {"status": "skipped", "reason": "No API key"}

    if not phone_number:
        return {"status": "skipped", "reason": "No emergency contact"}

    # Build Google Maps link for the location
    if lat and lng:
        maps_link = f"https://maps.google.com/?q={lat},{lng}"
        message   = (f"🚨 EMERGENCY SOS from {user_name}! "
                     f"They need immediate help. "
                     f"Location: {maps_link} "
                     f"Call 108 for ambulance.")
    else:
        message = (f"🚨 EMERGENCY SOS from {user_name}! "
                   f"They need immediate help. "
                   f"GPS unavailable. Call 108 immediately.")

    # Fast2SMS API call
    url     = "https://www.fast2sms.com/dev/bulkV2"
    payload = urllib.parse.urlencode({
        "route":    "q",       # Transactional route
        "message":  message,
        "language": "english",
        "flash":    0,
        "numbers":  str(phone_number),
    }).encode()

    try:
        req = urllib.request.Request(url, data=payload, method="POST")
        req.add_header("authorization", FAST2SMS_KEY)
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode())
        print(f"[SMS] Sent to {phone_number}: {result}")
        return {"status": "sent", "result": result}
    except Exception as e:
        print(f"[SMS error] {e}")
        return {"status": "error", "reason": str(e)}


def send_hazard_sms(phone_number, hazard_type, location):
    """
    Notifies admin/authority about a new hazard report via SMS.
    """
    if not FAST2SMS_KEY or not phone_number:
        return {"status": "skipped"}

    message = (f"⚠️ New Hazard Report on ResQNet: "
               f"{hazard_type} at {location}. "
               f"Please inspect and resolve.")

    url     = "https://www.fast2sms.com/dev/bulkV2"
    payload = urllib.parse.urlencode({
        "route": "q", "message": message,
        "language": "english", "flash": 0,
        "numbers": str(phone_number),
    }).encode()

    try:
        req = urllib.request.Request(url, data=payload, method="POST")
        req.add_header("authorization", FAST2SMS_KEY)
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode())
        return {"status": "sent", "result": result}
    except Exception as e:
        return {"status": "error", "reason": str(e)}
