import smtplib
import os
from email.mime.text        import MIMEText
from email.mime.multipart   import MIMEMultipart

GMAIL_USER = os.environ.get('GMAIL_USER', '')
GMAIL_PASS = os.environ.get('GMAIL_PASS', '')

def send_email(to_email, subject, html_body):
    """Send an email via Gmail SMTP. Returns True if successful."""
    if not GMAIL_USER or not GMAIL_PASS:
        print("⚠️ Email not configured — skipping.")
        return False
    if not to_email:
        return False

    try:
        msg                    = MIMEMultipart('alternative')
        msg['Subject']         = subject
        msg['From']            = f"ResQNet AI <{GMAIL_USER}>"
        msg['To']              = to_email
        msg.attach(MIMEText(html_body, 'html'))

        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
            server.login(GMAIL_USER, GMAIL_PASS)
            server.sendmail(GMAIL_USER, to_email, msg.as_string())

        print(f"✅ Email sent to {to_email}")
        return True

    except Exception as e:
        print(f"❌ Email failed: {e}")
        return False


def send_hazard_confirmation(to_email, hazard_type, location, report_id):
    """Email sent to user when their hazard is submitted."""
    subject = f"✅ ResQNet AI — Hazard Report #{report_id} Received"
    html    = f"""
    <div style="font-family:Arial,sans-serif;background:#0b0f1a;color:white;padding:30px;border-radius:12px;">
        <h1 style="color:red;">🚨 ResQNet AI</h1>
        <h2 style="color:white;">Your Hazard Report Has Been Received</h2>
        <div style="background:#16213e;padding:20px;border-radius:8px;margin:16px 0;">
            <p><strong style="color:red;">Report ID:</strong> #{report_id}</p>
            <p><strong style="color:red;">Hazard Type:</strong> {hazard_type}</p>
            <p><strong style="color:red;">Location:</strong> {location}</p>
            <p><strong style="color:red;">Status:</strong> 🔴 Open — Under Review</p>
        </div>
        <p style="color:#aaa;">Our team will investigate and update the status of your report.
        You will receive another email when the status changes.</p>
        <p style="color:#aaa;font-size:12px;margin-top:20px;">
            ResQNet AI | Road Safety Hackathon 2026 | IIT Madras
        </p>
    </div>
    """
    return send_email(to_email, subject, html)


def send_hazard_resolved(to_email, hazard_type, location, report_id):
    """Email sent to user when their hazard is resolved."""
    subject = f"🟢 ResQNet AI — Hazard Report #{report_id} Resolved"
    html    = f"""
    <div style="font-family:Arial,sans-serif;background:#0b0f1a;color:white;padding:30px;border-radius:12px;">
        <h1 style="color:red;">🚨 ResQNet AI</h1>
        <h2 style="color:lightgreen;">Your Hazard Report Has Been Resolved!</h2>
        <div style="background:#16213e;padding:20px;border-radius:8px;margin:16px 0;">
            <p><strong style="color:red;">Report ID:</strong> #{report_id}</p>
            <p><strong style="color:red;">Hazard Type:</strong> {hazard_type}</p>
            <p><strong style="color:red;">Location:</strong> {location}</p>
            <p><strong style="color:lightgreen;">Status:</strong> 🟢 Resolved</p>
        </div>
        <p style="color:#aaa;">Thank you for helping make our roads safer!
        Your report has been actioned by the authorities.</p>
        <p style="color:#aaa;font-size:12px;margin-top:20px;">
            ResQNet AI | Road Safety Hackathon 2026 | IIT Madras
        </p>
    </div>
    """
    return send_email(to_email, subject, html)


def send_sos_alert_email(to_email, user_name, lat, lng):
    """Email sent to emergency contact when SOS is triggered."""
    maps_link = f"https://maps.google.com/?q={lat},{lng}" if lat and lng else "Location unavailable"
    subject   = f"🚨 EMERGENCY — {user_name} has triggered SOS!"
    html      = f"""
    <div style="font-family:Arial,sans-serif;background:#0b0f1a;color:white;padding:30px;border-radius:12px;">
        <h1 style="color:red;">🚨 EMERGENCY ALERT</h1>
        <h2 style="color:white;">{user_name} needs help!</h2>
        <div style="background:#3a0000;padding:20px;border-radius:8px;margin:16px 0;border:2px solid red;">
            <p style="font-size:18px;"><strong>SOS has been triggered.</strong></p>
            <p>Call them immediately or contact emergency services.</p>
            <p><strong style="color:red;">📍 Live Location:</strong>
                <a href="{maps_link}" style="color:#4af;">View on Google Maps</a>
            </p>
        </div>
        <p style="color:#aaa;font-size:14px;">
            Call 108 for ambulance | Call 100 for police
        </p>
        <p style="color:#aaa;font-size:12px;margin-top:20px;">
            ResQNet AI | Road Safety Hackathon 2026 | IIT Madras
        </p>
    </div>
    """
    return send_email(to_email, subject, html)
