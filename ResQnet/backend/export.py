import csv
import io
from fpdf import FPDF
from backend.database import get_db

# ── Export reports as CSV ─────────────────────────────────────
def export_csv():
    conn  = get_db()
    rows  = conn.execute(
        "SELECT id, hazard_type, location, latitude, longitude, status, timestamp FROM hazard_reports ORDER BY timestamp DESC"
    ).fetchall()
    conn.close()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["ID", "Hazard Type", "Location", "Latitude", "Longitude", "Status", "Reported At"])
    for row in rows:
        writer.writerow([
            row["id"], row["hazard_type"], row["location"],
            row["latitude"] or "N/A", row["longitude"] or "N/A",
            row["status"], row["timestamp"]
        ])
    output.seek(0)
    return output.getvalue()


# ── Export reports as PDF ─────────────────────────────────────
def export_pdf():
    conn  = get_db()
    rows  = conn.execute(
        "SELECT id, hazard_type, location, status, timestamp FROM hazard_reports ORDER BY timestamp DESC"
    ).fetchall()
    sos_rows = conn.execute(
        "SELECT id, status, latitude, longitude, resolved, timestamp FROM emergency_logs ORDER BY timestamp DESC LIMIT 20"
    ).fetchall()
    conn.close()

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    # Title
    pdf.set_font("Helvetica", "B", 20)
    pdf.set_text_color(200, 0, 0)
    pdf.cell(0, 12, "ResQNet AI - Emergency Report", ln=True, align="C")
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(100, 100, 100)
    from datetime import datetime
    pdf.cell(0, 8, f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", ln=True, align="C")
    pdf.ln(6)

    # Hazard Reports Section
    pdf.set_font("Helvetica", "B", 14)
    pdf.set_text_color(200, 0, 0)
    pdf.cell(0, 10, "Hazard Reports", ln=True)
    pdf.set_draw_color(200, 0, 0)
    pdf.line(10, pdf.get_y(), 200, pdf.get_y())
    pdf.ln(3)

    # Table header
    pdf.set_fill_color(30, 30, 50)
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("Helvetica", "B", 9)
    col_w = [12, 38, 60, 25, 55]
    headers = ["ID", "Hazard Type", "Location", "Status", "Reported At"]
    for i, h in enumerate(headers):
        pdf.cell(col_w[i], 8, h, border=1, fill=True, align="C")
    pdf.ln()

    # Table rows
    pdf.set_font("Helvetica", "", 8)
    for idx, row in enumerate(rows):
        pdf.set_fill_color(245, 245, 250) if idx % 2 == 0 else pdf.set_fill_color(255, 255, 255)
        pdf.set_text_color(30, 30, 30)
        vals = [str(row["id"]), row["hazard_type"],
                row["location"][:30], row["status"],
                str(row["timestamp"])[:19]]
        for i, v in enumerate(vals):
            pdf.cell(col_w[i], 7, v, border=1, fill=True, align="C")
        pdf.ln()

    pdf.ln(8)

    # SOS Logs Section
    pdf.set_font("Helvetica", "B", 14)
    pdf.set_text_color(200, 0, 0)
    pdf.cell(0, 10, "SOS Emergency Logs", ln=True)
    pdf.line(10, pdf.get_y(), 200, pdf.get_y())
    pdf.ln(3)

    pdf.set_fill_color(30, 30, 50)
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("Helvetica", "B", 9)
    sos_cols = [12, 25, 35, 35, 30, 55]
    sos_headers = ["ID", "Status", "Latitude", "Longitude", "Resolved", "Timestamp"]
    for i, h in enumerate(sos_headers):
        pdf.cell(sos_cols[i], 8, h, border=1, fill=True, align="C")
    pdf.ln()

    pdf.set_font("Helvetica", "", 8)
    for idx, row in enumerate(sos_rows):
        pdf.set_fill_color(245, 245, 250) if idx % 2 == 0 else pdf.set_fill_color(255, 255, 255)
        pdf.set_text_color(30, 30, 30)
        vals = [
            str(row["id"]), row["status"],
            str(row["latitude"] or "N/A"), str(row["longitude"] or "N/A"),
            "Yes" if row["resolved"] else "No", str(row["timestamp"])[:19]
        ]
        for i, v in enumerate(vals):
            pdf.cell(sos_cols[i], 7, v, border=1, fill=True, align="C")
        pdf.ln()

    return bytes(pdf.output())
