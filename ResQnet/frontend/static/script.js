// ── Socket.IO live updates ────────────────────────────────────
const socket = io();
socket.on('stats_update', (data) => {
    updateStatCard('hazard-count', data.hazard_reports);
    updateStatCard('sos-count',    data.active_sos);
    updateStatCard('risk-level',   data.risk_level);
});
socket.on('sos_resolved', (data) => {
    const row = document.getElementById(`sos-row-${data.id}`);
    if (row) row.style.opacity = '0.4';
});

function updateStatCard(id, value) {
    const el = document.getElementById(id);
    if (el) { el.textContent = value; el.classList.add('updated'); setTimeout(() => el.classList.remove('updated'), 600); }
}

// ── Auth helpers ─────────────────────────────────────────────
function getToken()    { return localStorage.getItem('resqnet_token'); }
function getUser()     { return JSON.parse(localStorage.getItem('resqnet_user') || 'null'); }
function isLoggedIn()  { return !!getToken(); }
function authHeaders() { return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` }; }

function saveSession(data) {
    localStorage.setItem('resqnet_token', data.token);
    localStorage.setItem('resqnet_user', JSON.stringify({ name: data.name, role: data.role, phone: data.phone, emergency_contact: data.emergency_contact }));
}

function logout() {
    localStorage.removeItem('resqnet_token');
    localStorage.removeItem('resqnet_user');
    window.location.href = '/login';
}

// ── Update nav based on login state ──────────────────────────
document.addEventListener("DOMContentLoaded", function () {
    updateNav();
        // Check location permission on SOS page
    if (document.getElementById('sos-button')) {
        navigator.geolocation.getCurrentPosition(
            () => {},
            () => {
                const warn = document.getElementById('location-warning');
                if (warn) warn.style.display = 'block';
            }
        );
    }
    loadStats();
    loadReportsWithTimeline();
    initMap();
    loadCharts();
    loadAdminUsers();
    loadAdminReports();
    const savedLang = localStorage.getItem('resqnet_lang') || 'en';
    setLanguage(savedLang);
});

function updateNav() {
    const user     = getUser();
    const navExtra = document.getElementById('nav-extra');
    if (!navExtra) return;
    if (user) {
        navExtra.innerHTML = `
            <span style="color:#aaa;font-size:13px;">👤 ${user.name}</span>
            ${user.role === 'admin' ? '<a href="/admin">Admin</a>' : ''}
            <a href="#" onclick="logout()">Logout</a>`;
    } else {
        navExtra.innerHTML = `<a href="/login">Login / Register</a>`;
    }
}

// ── Stats ─────────────────────────────────────────────────────
function loadStats() {
    fetch('/api/stats')
        .then(r => r.json())
        .then(data => {
            updateStatCard('hazard-count', data.hazard_reports);
            updateStatCard('sos-count',    data.active_sos);
            updateStatCard('risk-level',   data.risk_level);
        })
        .catch(err => console.log("Stats error:", err));
}

// ── Reports table ─────────────────────────────────────────────
function loadReports() {
    const tbody = document.getElementById('reports-body');
    if (!tbody) return;
    fetch('/api/reports/all')
        .then(r => r.json())
        .then(data => {
            if (!data.length) {
                tbody.innerHTML = '<tr><td colspan="5" style="padding:20px;color:#aaa;">No reports yet.</td></tr>';
                return;
            }
            tbody.innerHTML = data.map(row => `
                <tr>
                    <td>${row.id}</td>
                    <td>${row.hazard_type}</td>
                    <td>${row.location}</td>
                    <td><span class="badge badge-${row.status}">${row.status}</span></td>
                    <td>${row.timestamp ? row.timestamp.split('.')[0] : 'N/A'}</td>
                </tr>`).join('');
        })
        .catch(() => { if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="color:#aaa;">Could not load reports.</td></tr>'; });
}

// ── Map ───────────────────────────────────────────────────────
let map       = null;
let heatLayer = null;

function initMap() {
    const mapEl = document.getElementById('map');
    if (!mapEl) { console.log("Map div not found"); return; }
    if (typeof L === 'undefined') { console.log("Leaflet not loaded"); return; }

    // Destroy existing map if reinitializing
    if (map) { map.remove(); map = null; }

    // Start with India overview, move to user location
    map = L.map('map', { zoomControl: true }).setView([20.5937, 78.9629], 5);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;

                // Move to user location
                map.setView([latitude, longitude], 13);

                // Blue dot for user
                L.marker([latitude, longitude], {
                    icon: L.divIcon({
                        className: '',
                        html: '<div style="background:blue;width:14px;height:14px;border-radius:50%;border:2px solid white;box-shadow:0 0 6px blue;"></div>'
                    })
                }).addTo(map).bindPopup("📍 Your Location").openPopup();

                // Load real nearby hospitals
                loadNearbyHospitals(latitude, longitude);

                // Load heatmap around user
                loadHeatmap(latitude, longitude);

                // Load blackspots
                loadBlackspots();
            },
            () => {
                console.log("Location denied, showing India map");
                loadHeatmap(null, null);
                loadBlackspots();
            }
        );
    } else {
        loadHeatmap(null, null);
        loadBlackspots();
    }
}

function loadNearbyHospitals(lat, lng) {
    const query = `[out:json][timeout:10];node["amenity"="hospital"](around:5000,${lat},${lng});out 3;`;
    const url   = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

    fetch(url)
        .then(r => r.json())
        .then(data => {
            if (!data.elements || data.elements.length === 0) return;
            data.elements.slice(0, 3).forEach(h => {
                const name = h.tags?.name || "Nearby Hospital";
                L.marker([h.lat, h.lon])
                    .addTo(map)
                    .bindPopup(`<b>🏥 ${name}</b><br>📍 Real hospital near you`);
            });
        })
        .catch(() => console.log("Hospital data not available"));
}

function loadHeatmap(userLat, userLng) {
    if (!map) { console.log("Map not ready"); return; }
    if (typeof L.heatLayer === 'undefined') { console.log("Leaflet.heat not loaded"); return; }

    fetch('/api/heatmap')
        .then(r => r.json())
        .then(points => {
            // If no real data, generate sample points around user location
            if (points.length === 0 && userLat && userLng) {
                points = [
                    [userLat,        userLng,        1.0],
                    [userLat + 0.01, userLng + 0.01, 0.8],
                    [userLat - 0.01, userLng + 0.02, 0.9],
                    [userLat + 0.02, userLng - 0.01, 0.7],
                    [userLat - 0.02, userLng - 0.02, 0.6],
                    [userLat + 0.01, userLng - 0.02, 0.5],
                    [userLat - 0.01, userLng + 0.01, 0.8],
                ];
            }

            if (heatLayer) map.removeLayer(heatLayer);

            if (points.length > 0) {
                heatLayer = L.heatLayer(points, {
                    radius:   25,
                    blur:     20,
                    maxZoom:  17,
                    max:      1.0,
                    gradient: { 0.0: 'blue', 0.3: 'cyan', 0.5: 'lime', 0.7: 'orange', 1.0: 'red' }
                }).addTo(map);
            }
        })
        .catch(() => console.log("Heatmap not available"));
}

function toggleHeatmap() {
    const btn = document.getElementById('heatmap-toggle-btn');
    if (!heatLayer || !map) return;
    if (map.hasLayer(heatLayer)) {
        map.removeLayer(heatLayer);
        if (btn) btn.textContent = '👁️ Show Heatmap';
    } else {
        map.addLayer(heatLayer);
        if (btn) btn.textContent = '👁️ Hide Heatmap';
    }
}

function loadBlackspots() {
    if (!map) return;
    fetch('/api/blackspots')
        .then(r => r.json())
        .then(spots => {
            spots.forEach(spot => {
                L.circle([spot.lat, spot.lng], {
                    color: 'red', fillColor: '#f03',
                    fillOpacity: 0.35, radius: 300
                }).addTo(map).bindPopup(
                    `<b>⚠️ Blackspot</b><br>${spot.count} reports<br>${spot.types.join(', ')}`
                );
            });
        })
        .catch(() => {});
}

// ── SOS ───────────────────────────────────────────────────────
function sendSOS() {
    const statusEl = document.getElementById('sos-status');
    const btn      = document.getElementById('sos-button');
    if (!statusEl) return;

    statusEl.style.color = 'yellow';
    statusEl.textContent = "📡 Getting your location...";
    if (btn) btn.disabled = true;

    startCountdown();

    if (!navigator.geolocation) {
        statusEl.style.color = 'red';
        statusEl.textContent = "❌ Location not supported. Call 108 immediately.";
        if (btn) btn.disabled = false;
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const { latitude, longitude } = pos.coords;
            statusEl.textContent = "🚨 Sending SOS to emergency services...";
            fetch('/api/sos', {
                method:  'POST',
                headers: authHeaders(),
                body:    JSON.stringify({ latitude, longitude })
            })
            .then(r => r.json())
            .then(data => {
                statusEl.style.color = 'lightgreen';
                statusEl.textContent = "✅ SOS Sent! Help is on the way. Stay calm.";
                const lang   = localStorage.getItem('resqnet_lang') || 'en';
                const sosMsg = {
                    en: "SOS sent successfully. Emergency services have been alerted. Help is on the way. Stay calm and do not move.",
                    ta: "SOS அனுப்பப்பட்டது. அவசர சேவைகள் அறிவிக்கப்பட்டன. உதவி வருகிறது. அமைதியாக இருங்கள்.",
                    hi: "SOS भेज दिया गया। आपातकालीन सेवाओं को सूचित किया गया। मदद आ रही है। शांत रहें।"
                };
                speakMessage(sosMsg[lang] || sosMsg.en, lang);
                showServices(data.nearby_services);
                showWhatsAppShare(latitude, longitude);
                startLiveTracking();
            })
            .catch(() => {
                statusEl.style.color = 'red';
                statusEl.textContent = "❌ Server error. Call 108 directly now!";
                if (btn) btn.disabled = false;
            });
        },
        () => {
            statusEl.style.color = 'orange';
            statusEl.textContent = "⚠️ GPS denied. Trying approximate location...";

            getIPLocation().then(ipLoc => {
                if (ipLoc) {
                    statusEl.textContent = `📡 Using approximate location: ${ipLoc.city}`;
                    fetch('/api/sos', {
                        method:  'POST',
                        headers: authHeaders(),
                        body:    JSON.stringify({ latitude: ipLoc.latitude, longitude: ipLoc.longitude })
                    })
                    .then(r => r.json())
                    .then(data => {
                        statusEl.style.color = 'lightgreen';
                        statusEl.textContent = `✅ SOS Sent! Approx location: ${ipLoc.city}`;
                        showServices(data.nearby_services);
                        startLiveTracking();
                    });
                } else {
                    // Last resort — show manual input
                    statusEl.textContent = "❌ No GPS. Enter location manually below.";
                    const manualDiv = document.getElementById('manual-location');
                    if (manualDiv) manualDiv.style.display = 'block';
                }
            });
        }
    );
}

function startCountdown(minutes = 6) {
    const el = document.getElementById('sos-countdown');
    if (!el) return;
    el.style.display = 'block';
    let total = minutes * 60;
    const interval = setInterval(() => {
        const m = Math.floor(total / 60);
        const s = total % 60;
        el.textContent = `🚑 Estimated arrival: ${m}:${s.toString().padStart(2, '0')}`;
        if (--total < 0) { clearInterval(interval); el.textContent = "🚑 Ambulance should be arriving now!"; }
    }, 1000);
}

function showWhatsAppShare(lat, lng) {
    const el = document.getElementById('whatsapp-share');
    if (!el) return;
    const msg = encodeURIComponent(`🚨 EMERGENCY! I need help. My location: https://maps.google.com/?q=${lat},${lng} — Please call 108 for me!`);
    el.innerHTML = `<a href="https://wa.me/?text=${msg}" target="_blank" class="btn" style="background:#25D366;margin-top:16px;">📲 Share Location on WhatsApp</a>`;
    el.style.display = 'block';
}

function showServices(services) {
    const section = document.getElementById('services-section');
    const list    = document.getElementById('services-list');
    if (!section || !list) return;

    const sourceLabel = {
        'openstreetmap': '🗺️ Live OpenStreetMap Data',
        'google_maps':   '📡 Live Google Maps Data',
        'fallback':      '⚠️ GPS needed for live results',
    };
    const sourceBg    = { openstreetmap: '#1a3a2a', google_maps: '#1a3a1a', fallback: '#3a1a1a' };
    const sourceColor = { openstreetmap: 'lightgreen', google_maps: 'lightgreen', fallback: 'orange' };
    const src   = services.source || 'fallback';
    const badge = `<span style="background:${sourceBg[src]};color:${sourceColor[src]};padding:4px 12px;border-radius:20px;font-size:13px;">${sourceLabel[src]}</span>`;

    let html = `<p style="margin-bottom:16px;">${badge}</p>`;
    (services.hospitals || []).forEach(h => {
        html += `<div class="card"><div class="card-icon">🏥</div><h3>${h.name}</h3><p>${h.distance} | 📞 ${h.phone}</p></div>`;
    });
    (services.ambulance || []).forEach(a => {
        html += `<div class="card"><div class="card-icon">🚑</div><h3>${a.name}</h3><p>ETA: ${a.eta}</p></div>`;
    });
    (services.police || []).forEach(p => {
        html += `<div class="card"><div class="card-icon">👮</div><h3>${p.name}</h3><p>${p.distance} | 📞 ${p.phone}</p></div>`;
    });
    list.innerHTML = html;
    section.style.display = 'block';
    section.scrollIntoView({ behavior: 'smooth' });
}

// ── Hazard report ─────────────────────────────────────────────
function submitHazardReport(event) {
    event.preventDefault();
    const hazardType = document.getElementById('hazardType').value;
    const location   = document.getElementById('location').value.trim();
    const statusEl   = document.getElementById('form-status');
    const photoInput = document.getElementById('photo');

    if (!hazardType || !location) {
        if (statusEl) { statusEl.style.color = 'red'; statusEl.textContent = "❌ Please fill all fields."; }
        return;
    }
    if (statusEl) { statusEl.style.color = 'yellow'; statusEl.textContent = "📡 Getting location & submitting..."; }

    const doSubmit = (lat, lng) => {
        const formData = new FormData();
        formData.append('hazard_type', hazardType);
        formData.append('location',    location);
        if (lat) formData.append('latitude',  lat);
        if (lng) formData.append('longitude', lng);
        if (photoInput && photoInput.files[0]) formData.append('photo', photoInput.files[0]);

        const headers = isLoggedIn() ? { 'Authorization': `Bearer ${getToken()}` } : {};

        fetch('/api/report', { method: 'POST', headers, body: formData })
            .then(r => r.json())
            .then(data => {
                if (data.status === 'success') {
                    if (statusEl) { statusEl.style.color = 'lightgreen'; statusEl.textContent = "✅ Hazard reported successfully!"; }
                    document.getElementById('hazard-form').reset();
                } else {
                    if (statusEl) { statusEl.style.color = 'red'; statusEl.textContent = "❌ " + data.message; }
                }
            })
            .catch(() => { if (statusEl) { statusEl.style.color = 'red'; statusEl.textContent = "❌ Submission failed."; } });
    };

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            pos => doSubmit(pos.coords.latitude, pos.coords.longitude),
            ()  => doSubmit(null, null)
        );
    } else { doSubmit(null, null); }
}

// ── Severity predictor ────────────────────────────────────────
function predictSeverity() {
    const speed       = parseInt(document.getElementById('speed')?.value) || 0;
    const weather     = document.getElementById('weather')?.value || 'clear';
    const road_type   = document.getElementById('road_type')?.value || 'urban';
    const time_of_day = parseInt(document.getElementById('time_of_day')?.value) || new Date().getHours();
    const resultEl    = document.getElementById('severity-result');
    const weatherEl   = document.getElementById('weather-live-badge');

    if (resultEl) resultEl.textContent = "Predicting...";

    const doPredict = (lat, lng) => {
        fetch('/api/predict', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ speed, weather, road_type, time_of_day, latitude: lat, longitude: lng })
        })
        .then(r => r.json())
        .then(data => {
            const colorMap = { Minor: 'lightgreen', Moderate: 'orange', Severe: 'red' };
            if (resultEl) {
                resultEl.style.color = colorMap[data.severity] || 'white';
                resultEl.textContent = `Predicted Severity: ${data.severity}`;
                speakSeverity(data.severity);
            }
            if (weatherEl && data.weather_live) {
                weatherEl.textContent   = `🌤️ Live weather used: ${data.weather_used}`;
                weatherEl.style.display = 'block';
            }
        })
        .catch(() => { if (resultEl) { resultEl.style.color = 'red'; resultEl.textContent = "Prediction failed."; } });
    };

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            pos => doPredict(pos.coords.latitude, pos.coords.longitude),
            ()  => doPredict(null, null)
        );
    } else { doPredict(null, null); }
}

// ── Login / Register ──────────────────────────────────────────
function handleLogin(event) {
    event.preventDefault();
    const email    = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const statusEl = document.getElementById('auth-status');

    fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    })
    .then(r => r.json())
    .then(data => {
        if (data.status === 'success') { saveSession(data); window.location.href = '/dashboard'; }
        else { if (statusEl) { statusEl.style.color = 'red'; statusEl.textContent = "❌ " + data.message; } }
    });
}

function handleRegister(event) {
    event.preventDefault();
    const name      = document.getElementById('reg-name').value;
    const email     = document.getElementById('reg-email').value;
    const password  = document.getElementById('reg-password').value;
    const phone     = document.getElementById('reg-phone').value;
    const emergency = document.getElementById('reg-emergency_contact').value;
    const statusEl  = document.getElementById('reg-auth-status');

    fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, phone, emergency_contact: emergency })
    })
    .then(r => r.json())
    .then(data => {
        if (data.status === 'success') { saveSession(data); window.location.href = '/dashboard'; }
        else { if (statusEl) { statusEl.style.color = 'red'; statusEl.textContent = "❌ " + data.message; } }
    });
}

// ── Admin ─────────────────────────────────────────────────────
function loadAdminSOS() {
    const tbody = document.getElementById('admin-sos-body');
    if (!tbody) return;
    fetch('/api/admin/sos', { headers: authHeaders() })
        .then(r => r.json())
        .then(data => {
            tbody.innerHTML = data.map(row => `
                <tr id="sos-row-${row.id}" style="${row.resolved ? 'opacity:0.4' : ''}">
                    <td>${row.id}</td>
                    <td>${row.status}</td>
                    <td>${row.latitude || 'N/A'}</td>
                    <td>${row.longitude || 'N/A'}</td>
                    <td>${row.resolved ? '✅ Resolved' : `<button class="btn" style="padding:4px 10px;font-size:12px;" onclick="resolveSOS(${row.id})">Resolve</button>`}</td>
                    <td>${row.timestamp ? row.timestamp.split('.')[0] : 'N/A'}</td>
                </tr>`).join('');
        });
}

function resolveSOS(id) {
    fetch(`/api/admin/resolve/${id}`, { method: 'POST', headers: authHeaders() })
        .then(() => loadAdminSOS());
}

function exportCSV() { window.location.href = '/api/export/csv'; }
function exportPDF()  { window.location.href = '/api/export/pdf'; }

// ── Voice SOS ─────────────────────────────────────────────────
let voiceListening = false;
let recognition    = null;

function startVoiceSOS() {
    const btn      = document.getElementById('voice-sos-btn');
    const statusEl = document.getElementById('voice-status');

    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        if (statusEl) { statusEl.style.color = 'red'; statusEl.textContent = "❌ Voice not supported. Use Chrome."; }
        return;
    }

    if (voiceListening) {
        recognition.stop();
        voiceListening = false;
        if (btn) { btn.textContent = "🎤 Start Voice SOS"; btn.style.background = "red"; }
        if (statusEl) statusEl.textContent = "";
        return;
    }

    recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    recognition.continuous     = true;
    recognition.interimResults = false;
    recognition.lang           = 'en-IN';

    recognition.onstart = () => {
        voiceListening = true;
        if (btn) { btn.textContent = "🔴 Listening... (click to stop)"; btn.style.background = "darkred"; }
        if (statusEl) { statusEl.style.color = 'yellow'; statusEl.textContent = "🎤 Listening for 'Help' or 'SOS'..."; }
    };

    recognition.onresult = (event) => {
        const transcript = event.results[event.results.length - 1][0].transcript.toLowerCase().trim();
        if (statusEl) { statusEl.style.color = 'white'; statusEl.textContent = `Heard: "${transcript}"`; }

        if (transcript.includes('help') || transcript.includes('sos') || transcript.includes('emergency') || transcript.includes('accident')) {
            recognition.stop();
            voiceListening = false;
            if (btn) { btn.textContent = "🎤 Start Voice SOS"; btn.style.background = "red"; }
            if (statusEl) { statusEl.style.color = 'lightgreen'; statusEl.textContent = "✅ Voice detected! Triggering SOS..."; }
            const lang   = localStorage.getItem('resqnet_lang') || 'en';
            const sosMsg = {
                en: "SOS sent successfully. Emergency services have been alerted. Help is on the way. Stay calm and do not move.",
                ta: "SOS அனுப்பப்பட்டது. அவசர சேவைகள் அறிவிக்கப்பட்டன. உதவி வருகிறது. அமைதியாக இருங்கள்.",
                hi: "SOS भेज दिया गया। आपातकालीन सेवाओं को सूचित किया गया। मदद आ रही है। शांत रहें।"
            };
            speakMessage(sosMsg[lang] || sosMsg.en, lang);
            sendSOS();
        }
    };

    recognition.onerror = (event) => {
        voiceListening = false;
        if (btn) { btn.textContent = "🎤 Start Voice SOS"; btn.style.background = "red"; }
        if (statusEl) { statusEl.style.color = 'red'; statusEl.textContent = "❌ Mic error: " + event.error; }
    };

    recognition.onend = () => { if (voiceListening) recognition.start(); };
    recognition.start();
}

// ── Voice Announcements ───────────────────────────────────────
function speakMessage(message, lang) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance  = new SpeechSynthesisUtterance(message);
    const langMap    = { en: 'en-IN', ta: 'ta-IN', hi: 'hi-IN' };
    utterance.lang   = langMap[lang] || langMap[localStorage.getItem('resqnet_lang')] || 'en-IN';
    utterance.rate   = 0.9;
    utterance.pitch  = 1.0;
    utterance.volume = 1.0;
    const voices     = window.speechSynthesis.getVoices();
    const preferred  = voices.find(v => v.lang.startsWith(utterance.lang.split('-')[0]));
    if (preferred) utterance.voice = preferred;
    window.speechSynthesis.speak(utterance);
}

function speakSeverity(severity) {
    const lang     = localStorage.getItem('resqnet_lang') || 'en';
    const messages = {
        en: { Minor: "Predicted severity is Minor. Stay alert.", Moderate: "Warning. Severity is Moderate. Reduce speed.", Severe: "Danger! Severity is Severe. Trigger SOS immediately." },
        ta: { Minor: "கணிக்கப்பட்ட தீவிரம் சிறியது. கவனமாக செல்லவும்.", Moderate: "எச்சரிக்கை. தீவிரம் மிதமானது.", Severe: "ஆபத்து! உடனே SOS அனுப்பவும்." },
        hi: { Minor: "गंभीरता मामूली है। सतर्क रहें।", Moderate: "चेतावनी। गंभीरता मध्यम है।", Severe: "खतरा! तुरंत SOS भेजें।" }
    };
    speakMessage((messages[lang] || messages.en)[severity] || "", lang);
}

// ── Crash Detection ───────────────────────────────────────────
let crashDetectionActive = false;
let crashCountdown       = null;

function startCrashDetection() {
    const btn      = document.getElementById('crash-detect-btn');
    const statusEl = document.getElementById('crash-status');

    if (crashDetectionActive) { stopCrashDetection(); return; }

    if (!window.DeviceMotionEvent) {
        if (statusEl) { statusEl.style.color = 'red'; statusEl.textContent = "❌ Accelerometer not supported."; }
        return;
    }

    if (typeof DeviceMotionEvent.requestPermission === 'function') {
        DeviceMotionEvent.requestPermission()
            .then(response => {
                if (response === 'granted') activateCrashDetection(btn, statusEl);
                else if (statusEl) { statusEl.style.color = 'red'; statusEl.textContent = "❌ Motion permission denied."; }
            })
            .catch(() => { if (statusEl) { statusEl.style.color = 'red'; statusEl.textContent = "❌ Permission error."; } });
    } else {
        activateCrashDetection(btn, statusEl);
    }
}

function activateCrashDetection(btn, statusEl) {
    crashDetectionActive = true;
    if (btn) { btn.textContent = "🔴 Monitoring... (tap to stop)"; btn.style.background = "darkred"; }
    if (statusEl) { statusEl.style.color = 'lightgreen'; statusEl.textContent = "✅ Crash detection active."; }
    window.addEventListener('devicemotion', handleMotion);
}

function stopCrashDetection() {
    crashDetectionActive = false;
    window.removeEventListener('devicemotion', handleMotion);
    const btn      = document.getElementById('crash-detect-btn');
    const statusEl = document.getElementById('crash-status');
    if (btn) { btn.textContent = "📱 Start Crash Detection"; btn.style.background = "red"; }
    if (statusEl) { statusEl.style.color = '#aaa'; statusEl.textContent = "Crash detection stopped."; }
    if (crashCountdown) {
        clearInterval(crashCountdown);
        crashCountdown = null;
        const overlay = document.getElementById('crash-overlay');
        if (overlay) overlay.style.display = 'none';
    }
}

function handleMotion(event) {
    const acc = event.accelerationIncludingGravity;
    if (!acc) return;
    const total = Math.sqrt((acc.x || 0) ** 2 + (acc.y || 0) ** 2 + (acc.z || 0) ** 2);
    if (total > 25) {
        window.removeEventListener('devicemotion', handleMotion);
        triggerCrashCountdown();
    }
}

function triggerCrashCountdown() {
    const overlay  = document.getElementById('crash-overlay');
    const countEl  = document.getElementById('crash-countdown-num');
    const statusEl = document.getElementById('crash-status');
    if (statusEl) { statusEl.style.color = 'red'; statusEl.textContent = "💥 Impact detected! SOS in 10 seconds..."; }
    speakMessage("Crash detected. SOS will be sent in 10 seconds. Tap cancel if you are safe.", 'en');
    if (overlay) overlay.style.display = 'flex';
    let count = 10;
    if (countEl) countEl.textContent = count;
    crashCountdown = setInterval(() => {
        count--;
        if (countEl) countEl.textContent = count;
        if (count <= 0) {
            clearInterval(crashCountdown);
            crashCountdown = null;
            if (overlay) overlay.style.display = 'none';
            speakMessage("Sending SOS now.", 'en');
            sendSOS();
        }
    }, 1000);
}

function cancelCrashSOS() {
    if (crashCountdown) { clearInterval(crashCountdown); crashCountdown = null; }
    const overlay  = document.getElementById('crash-overlay');
    const statusEl = document.getElementById('crash-status');
    if (overlay) overlay.style.display = 'none';
    if (statusEl) { statusEl.style.color = 'lightgreen'; statusEl.textContent = "✅ SOS cancelled. You are safe."; }
    speakMessage("SOS cancelled. You marked yourself as safe.", 'en');
    setTimeout(() => {
        if (crashDetectionActive) {
            window.addEventListener('devicemotion', handleMotion);
            if (statusEl) statusEl.textContent = "✅ Crash detection active.";
        }
    }, 3000);
}

// ── Charts ────────────────────────────────────────────────────
let pieChart  = null;
let barChart  = null;
let lineChart = null;

function loadCharts() {
    const pieEl  = document.getElementById('hazardPieChart');
    const barEl  = document.getElementById('hourBarChart');
    const lineEl = document.getElementById('sosLineChart');
    if (!pieEl && !barEl && !lineEl) return;

    fetch('/api/reports/all')
        .then(r => r.json())
        .then(data => { buildPieChart(data); buildBarChart(data); })
        .catch(() => console.log("Chart data not available"));

    fetch('/api/admin/sos', { headers: authHeaders() })
        .then(r => r.json())
        .then(data => buildLineChart(data))
        .catch(() => buildLineChartFallback());
}

function buildPieChart(reports) {
    const el = document.getElementById('hazardPieChart');
    if (!el) return;
    const counts = {};
    reports.forEach(r => { counts[r.hazard_type] = (counts[r.hazard_type] || 0) + 1; });
    const labels = Object.keys(counts);
    const values = Object.values(counts);
    if (labels.length === 0) { el.parentElement.innerHTML += '<p style="color:#aaa;margin-top:10px;">No data yet.</p>'; return; }
    if (pieChart) pieChart.destroy();
    pieChart = new Chart(el, {
        type: 'pie',
        data: { labels, datasets: [{ data: values, backgroundColor: ['#e74c3c','#e67e22','#f1c40f','#2ecc71','#3498db','#9b59b6'], borderColor: '#0b0f1a', borderWidth: 2 }] },
        options: { plugins: { legend: { labels: { color: 'white', font: { size: 13 } } } } }
    });
}

function buildBarChart(reports) {
    const el = document.getElementById('hourBarChart');
    if (!el) return;
    const hourCounts = Array(24).fill(0);
    reports.forEach(r => { if (r.timestamp) { const h = new Date(r.timestamp).getHours(); if (!isNaN(h)) hourCounts[h]++; } });
    if (barChart) barChart.destroy();
    barChart = new Chart(el, {
        type: 'bar',
        data: { labels: Array.from({length:24},(_,i)=>`${i}:00`), datasets: [{ label:'Reports', data: hourCounts, backgroundColor:'rgba(231,76,60,0.7)', borderColor:'#e74c3c', borderWidth:1 }] },
        options: { plugins:{legend:{labels:{color:'white'}}}, scales:{ x:{ticks:{color:'#aaa',maxRotation:45},grid:{color:'rgba(255,255,255,0.05)'}}, y:{ticks:{color:'#aaa'},grid:{color:'rgba(255,255,255,0.05)'},beginAtZero:true} } }
    });
}

function buildLineChart(sosLogs) {
    const el = document.getElementById('sosLineChart');
    if (!el) return;
    const dateCounts = {};
    sosLogs.forEach(s => { if (s.timestamp) { const date = s.timestamp.split('T')[0] || s.timestamp.split(' ')[0]; dateCounts[date] = (dateCounts[date]||0)+1; } });
    const labels = Object.keys(dateCounts).sort();
    const values = labels.map(d => dateCounts[d]);
    if (labels.length === 0) { buildLineChartFallback(); return; }
    if (lineChart) lineChart.destroy();
    lineChart = new Chart(el, {
        type: 'line',
        data: { labels, datasets: [{ label:'SOS Alerts', data:values, borderColor:'#e74c3c', backgroundColor:'rgba(231,76,60,0.1)', borderWidth:2, pointBackgroundColor:'#e74c3c', fill:true, tension:0.4 }] },
        options: { plugins:{legend:{labels:{color:'white'}}}, scales:{ x:{ticks:{color:'#aaa'},grid:{color:'rgba(255,255,255,0.05)'}}, y:{ticks:{color:'#aaa'},grid:{color:'rgba(255,255,255,0.05)'},beginAtZero:true} } }
    });
}

function buildLineChartFallback() {
    const el = document.getElementById('sosLineChart');
    if (!el) return;
    if (lineChart) lineChart.destroy();
    lineChart = new Chart(el, {
        type: 'line',
        data: { labels:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], datasets:[{ label:'SOS Alerts (sample)', data:[1,3,2,5,4,6,3], borderColor:'#e74c3c', backgroundColor:'rgba(231,76,60,0.1)', borderWidth:2, pointBackgroundColor:'#e74c3c', fill:true, tension:0.4 }] },
        options: { plugins:{legend:{labels:{color:'white'}}}, scales:{ x:{ticks:{color:'#aaa'},grid:{color:'rgba(255,255,255,0.05)'}}, y:{ticks:{color:'#aaa'},grid:{color:'rgba(255,255,255,0.05)'},beginAtZero:true} } }
    });
}

// ── Language ──────────────────────────────────────────────────
const translations = {
    en: {
        home:'Home', dashboard:'Dashboard', nav_sos:'SOS', nav_report:'Report Hazard',
        nav_login:'Login / Register', nav_logout:'Logout', nav_admin:'Admin',
        tagline:'Predict. Protect. Respond.',
        hero_index_h:'AI-Powered Road Emergency Response',
        hero_index_p:'Smart rescue coordination, accident prevention, and citizen road safety — all in one platform.',
        btn_launch_dashboard:'Launch Dashboard', btn_emergency_sos:'Emergency SOS',
        stat_fatalities:'Annual Road Fatalities in India', stat_delayed:'Deaths Due to Delayed Rescue',
        stat_access:'Emergency Response Access', stat_ambulance:'Average Ambulance Arrival',
        feat_locator_h:'Emergency Locator', feat_locator_p:'Find nearby trauma centers and police stations instantly using live OpenStreetMap data.',
        feat_sos_h:'One-Tap SOS', feat_sos_p:'Trigger emergency alerts with live GPS. SMS sent to your emergency contact automatically.',
        feat_ai_h:'AI Severity Detection', feat_ai_p:'Predicts accident severity using live weather, speed, road type, and time of day.',
        feat_hazard_h:'Hazard Reporting', feat_hazard_p:'Report potholes, broken signals, and flood zones with photo evidence and GPS tagging.',
        feat_blackspot_h:'Blackspot Heatmap', feat_blackspot_p:'Auto-detected accident blackspots from clustered hazard reports on the live map.',
        feat_whatsapp_h:'WhatsApp SOS Share', feat_whatsapp_p:'Instantly share your GPS location to family via WhatsApp when SOS is triggered.',
        footer_index:'ResQNet AI | Road Safety Hackathon 2026 | IIT Madras',
        sos:'🆘 SEND SOS', hero_sos_h:'Immediate Rescue Activation',
        hero_sos_p:'One-tap emergency response with live GPS, SMS alert to your emergency contact, and real nearby services.',
        stat_ambulance_num:'Ambulance', stat_gps:'GPS Tracking', stat_emergency_access:'Emergency Access',
        stat_police:'Police Helpline', stat_national:'National Emergency',
        nearby_services_h:'🚑 Nearby Emergency Services', footer_sos:'Saving Minutes Means Saving Lives | ResQNet AI',
        hero_report_h:'Citizen-Powered Road Safety', hero_report_p:'Report potholes, damaged roads, flood zones, and accidents with photo evidence.',
        submit_hazard_h:'📝 Submit a Hazard Report', lbl_hazard_type:'Hazard Type',
        opt_select:'-- Select Hazard Type --', opt_pothole:'Pothole', opt_signal:'Broken Signal',
        opt_flood:'Flood Zone', opt_road_damage:'Road Damage', opt_accident:'Accident Spot', opt_other:'Other',
        lbl_location:'Location Description', lbl_photo:'📷 Photo Evidence (optional)', report:'Submit Report',
        ai_predictor_h:'🤖 AI Accident Severity Predictor', lbl_speed:'Speed (km/h)', lbl_weather:'Weather',
        opt_clear:'Clear', opt_rain:'Rain', opt_fog:'Fog', opt_storm:'Storm', opt_cloudy:'Cloudy',
        lbl_road_type:'Road Type', opt_urban:'Urban', opt_highway:'Highway', opt_rural:'Rural',
        lbl_hour:'Hour of Day (0–23)', predict_btn:'🤖 Predict Severity',
        footer_report:'Safer Roads Through Citizen Action | ResQNet AI',
        hero_dash_h:'Real-Time Emergency Intelligence', hero_dash_p:'Live accident monitoring, rescue service locator, and AI blackspot detection.',
        stat_risk:'Current Risk Level', stat_hazards:'Hazards Reported', stat_active_sos:'Active SOS Alerts',
        stat_amb_help:'Ambulance Helpline', stat_pol_help:'Police Helpline',
        dash_hospital_h:'Live Hospital Locator', dash_hospital_p:'Real hospitals via OpenStreetMap with distances and phone numbers.',
        dash_ambulance_h:'Ambulance ETA', dash_ambulance_p:'Estimated arrival time calculated from your GPS distance.',
        dash_blackspot_h:'Blackspot Heatmap', dash_blackspot_p:'Auto-detected danger zones from clustered citizen reports.',
        dash_export_h:'Export Reports', export_csv:'📥 CSV', export_pdf:'📄 PDF',
        map_heading:'📍 Live Emergency Map', reports_heading:'📋 Recent Hazard Reports',
        th_id:'ID', th_hazard_type:'Hazard Type', th_location:'Location', th_status:'Status', th_reported_at:'Reported At',
        footer_dash:'ResQNet AI Dashboard | IIT Madras Hackathon 2026',
        admin_tagline:'Admin Panel', admin_hero_h:'🛡️ Admin Control Panel',
        admin_hero_p:'Manage SOS alerts, resolve hazard reports, and export data.',
        admin_export_csv:'📥 Export CSV', admin_export_pdf:'📄 Export PDF',
        stat_total_hazards:'Total Hazards', stat_active_sos_admin:'Active SOS', stat_risk_admin:'Risk Level',
        admin_sos_h:'🚨 SOS Emergency Logs', th_lat:'Latitude', th_lng:'Longitude', th_action:'Action', th_timestamp:'Timestamp',
        admin_reports_h:'📋 Hazard Reports', footer_admin:'ResQNet Admin | Restricted Access',
        login_hero_h:'Login or Register', login_hero_p:'Create an account to enable SMS alerts to your emergency contact when SOS is triggered.',
        btn_login_tab:'Login', btn_register_tab:'Register', login_form_h:'Login to ResQNet',
        lbl_email:'Email', lbl_password:'Password', btn_login:'Login',
        register_form_h:'Create Account', lbl_name:'Full Name', lbl_phone:'Phone Number',
        lbl_emergency:'Emergency Contact Number', btn_register:'Create Account',
        footer_login:'ResQNet AI | IIT Madras Hackathon 2026',
        // Women's Safety
        ws_btn:'👩 Women\'s Safety', ws_title:'Women\'s Safety — Safe Journey Mode',
        ws_dest:'Destination', ws_transport:'Transport Type', ws_vehicle:'Vehicle Number',
        ws_driver:'Driver Name (Optional)', ws_arrival:'Expected Arrival Time',
        ws_start:'🛡️ Start Safe Journey', ws_monitoring:'🟢 Journey Monitoring Active',
        ws_safe_q:'Are you safe?', ws_yes:'✅ Yes, I\'m Safe', ws_no:'🆘 No — HELP!',
        ws_emergency:'🚨 Emergency Mode Activated', ws_scan_ocr:'📷 Scan Vehicle Number',
        ws_shake:'📱 Shake-to-SOS Active', ws_checkin:'Safe Check-In',
        ws_arrived:'✅ I Have Arrived Safely', ws_not_arrived:'🆘 I Need Help',
        ws_dash_h:'Safety Dashboard', ws_total:'Total Journeys',
        ws_safe:'Safe Arrivals', ws_emg_count:'Emergency Activations',
        ws_nearby_police:'Nearby Police Stations', ws_nearby_hosp:'Nearby Hospitals',
        ws_transport_bus:'Bus', ws_transport_auto:'Auto', ws_transport_cab:'Cab',
        ws_transport_train:'Train', ws_transport_metro:'Metro', ws_transport_pvt:'Private Vehicle',
        ws_stop_journey:'⏹ End Journey', ws_rec_active:'🔴 Recording Evidence...',
        ws_medical:'Emergency Medical Profile', ws_blood:'Blood Group',
        ws_allergies:'Allergies', ws_emg_contact:'Emergency Contact',
        ws_med_notes:'Medical Notes',
    },
    ta: {
        home:'முகப்பு', dashboard:'டாஷ்போர்டு', nav_sos:'அவசர உதவி', nav_report:'ஆபத்து புகாரளி',
        nav_login:'உள்நுழை / பதிவு', nav_logout:'வெளியேறு', nav_admin:'நிர்வாகி',
        tagline:'கணிக்க. பாதுகாக்க. செயலிட.',
        hero_index_h:'AI சாலை அவசர மேலாண்மை',
        hero_index_p:'திறமையான மீட்பு ஒருங்கிணைப்பு, விபத்து தடுப்பு மற்றும் குடிமக்கள் சாலை பாதுகாப்பு — ஒரே தளத்தில்.',
        btn_launch_dashboard:'டாஷ்போர்டு திற', btn_emergency_sos:'அவசர SOS',
        stat_fatalities:'இந்தியாவில் ஆண்டு சாலை இறப்புகள்', stat_delayed:'தாமதமான மீட்பினால் இறப்புகள்',
        stat_access:'அவசர மீட்பு அணுகல்', stat_ambulance:'சராசரி ஆம்புலன்ஸ் வருகை',
        feat_locator_h:'அவசர சேவை கண்டுபிடிப்பு', feat_locator_p:'OpenStreetMap மூலம் அருகிலுள்ள மருத்துவமனை மற்றும் போலீஸ் நிலையங்களை உடனே கண்டறியவும்.',
        feat_sos_h:'ஒரே தட்டு SOS', feat_sos_p:'நேரடி GPS மூலம் அவசர எச்சரிக்கை. உங்கள் அவசர தொடர்பிற்கு SMS தானாக அனுப்பப்படும்.',
        feat_ai_h:'AI தீவிர கண்டறிதல்', feat_ai_p:'நேரடி வானிலை, வேகம், சாலை வகை மற்றும் நேரத்தின் அடிப்படையில் விபத்து தீவிரத்தை கணிக்கிறது.',
        feat_hazard_h:'ஆபத்து புகாரளிப்பு', feat_hazard_p:'குழிகள், உடைந்த சிக்னல்கள் மற்றும் வெள்ளப் பகுதிகளை புகைப்பட சான்றுகளுடன் புகாரளிக்கவும்.',
        feat_blackspot_h:'கருப்பு புள்ளி வரைபடம்', feat_blackspot_p:'குவிக்கப்பட்ட ஆபத்து புகார்களில் இருந்து தானாக கண்டறியப்பட்ட விபத்து கருப்பு புள்ளிகள்.',
        feat_whatsapp_h:'WhatsApp SOS பகிர்வு', feat_whatsapp_p:'SOS தூண்டப்படும்போது WhatsApp வழியாக உங்கள் குடும்பத்தினருக்கு GPS இருப்பிடத்தை பகிரவும்.',
        footer_index:'ResQNet AI | சாலை பாதுகாப்பு ஹேக்கதான் 2026 | IIT மதராஸ்',
        sos:'🆘 உதவி அனுப்பு', hero_sos_h:'உடனடி மீட்பு செயல்பாடு',
        hero_sos_p:'நேரடி GPS, உங்கள் அவசர தொடர்பிற்கு SMS மற்றும் அருகிலுள்ள சேவைகளுடன் ஒரே தட்டு அவசர மீட்பு.',
        stat_ambulance_num:'ஆம்புலன்ஸ்', stat_gps:'GPS கண்காணிப்பு', stat_emergency_access:'அவசர அணுகல்',
        stat_police:'போலீஸ் உதவி', stat_national:'தேசிய அவசரநிலை',
        nearby_services_h:'🚑 அருகிலுள்ள அவசர சேவைகள்', footer_sos:'நிமிடங்கள் மிச்சப்படுத்துவது உயிர்களை காக்கும் | ResQNet AI',
        hero_report_h:'குடிமக்கள் சாலை பாதுகாப்பு', hero_report_p:'குழிகள், சேதமடைந்த சாலைகள், வெள்ளப் பகுதிகள் மற்றும் விபத்துகளை புகைப்பட சான்றுகளுடன் புகாரளிக்கவும்.',
        submit_hazard_h:'📝 ஆபத்து புகாரை சமர்ப்பிக்கவும்', lbl_hazard_type:'ஆபத்து வகை',
        opt_select:'-- ஆபத்து வகையை தேர்ந்தெடுக்கவும் --', opt_pothole:'குழி', opt_signal:'உடைந்த சிக்னல்',
        opt_flood:'வெள்ளப் பகுதி', opt_road_damage:'சாலை சேதம்', opt_accident:'விபத்து இடம்', opt_other:'மற்றவை',
        lbl_location:'இருப்பிட விவரம்', lbl_photo:'📷 புகைப்பட சான்று (விருப்பத்தேர்வு)', report:'புகாரை சமர்ப்பி',
        ai_predictor_h:'🤖 AI விபத்து தீவிர கணிப்பான்', lbl_speed:'வேகம் (கி.மீ/மணி)', lbl_weather:'வானிலை',
        opt_clear:'தெளிவான', opt_rain:'மழை', opt_fog:'மூடுபனி', opt_storm:'புயல்', opt_cloudy:'மேகமூட்டம்',
        lbl_road_type:'சாலை வகை', opt_urban:'நகர்ப்புற', opt_highway:'நெடுஞ்சாலை', opt_rural:'கிராமப்புற',
        lbl_hour:'நாளின் மணி (0–23)', predict_btn:'🤖 தீவிரம் கணிக்கவும்',
        footer_report:'குடிமக்கள் செயலால் பாதுகாப்பான சாலைகள் | ResQNet AI',
        hero_dash_h:'நேரடி அவசர தகவல்', hero_dash_p:'நேரடி விபத்து கண்காணிப்பு, மீட்பு சேவை கண்டுபிடிப்பு மற்றும் AI கருப்பு புள்ளி கண்டறிதல்.',
        stat_risk:'தற்போதைய ஆபத்து நிலை', stat_hazards:'புகாரளிக்கப்பட்ட ஆபத்துகள்', stat_active_sos:'செயலில் உள்ள SOS எச்சரிக்கைகள்',
        stat_amb_help:'ஆம்புலன்ஸ் உதவி', stat_pol_help:'போலீஸ் உதவி',
        dash_hospital_h:'நேரடி மருத்துவமனை கண்டுபிடிப்பு', dash_hospital_p:'OpenStreetMap மூலம் தூரம் மற்றும் தொலைபேசி எண்களுடன் உண்மையான மருத்துவமனைகள்.',
        dash_ambulance_h:'ஆம்புலன்ஸ் வருகை நேரம்', dash_ambulance_p:'உங்கள் GPS தூரத்திலிருந்து கணக்கிடப்பட்ட வருகை நேரம்.',
        dash_blackspot_h:'கருப்பு புள்ளி வரைபடம்', dash_blackspot_p:'குவிக்கப்பட்ட குடிமக்கள் புகார்களில் இருந்து தானாக கண்டறியப்பட்ட ஆபத்து மண்டலங்கள்.',
        dash_export_h:'அறிக்கைகளை ஏற்றுமதி செய்', export_csv:'📥 CSV', export_pdf:'📄 PDF',
        map_heading:'📍 நேரடி அவசர வரைபடம்', reports_heading:'📋 சமீபத்திய ஆபத்து புகார்கள்',
        th_id:'எண்', th_hazard_type:'ஆபத்து வகை', th_location:'இடம்', th_status:'நிலை', th_reported_at:'புகாரளித்த நேரம்',
        footer_dash:'ResQNet AI டாஷ்போர்டு | IIT மதராஸ் ஹேக்கதான் 2026',
        admin_tagline:'நிர்வாக பலகம்', admin_hero_h:'🛡️ நிர்வாக கட்டுப்பாட்டு பலகம்',
        admin_hero_p:'SOS எச்சரிக்கைகளை நிர்வகி, ஆபத்து புகார்களை தீர்க்கவும் மற்றும் தரவை ஏற்றுமதி செய்யவும்.',
        admin_export_csv:'📥 CSV ஏற்றுமதி', admin_export_pdf:'📄 PDF ஏற்றுமதி',
        stat_total_hazards:'மொத்த ஆபத்துகள்', stat_active_sos_admin:'செயலில் உள்ள SOS', stat_risk_admin:'ஆபத்து நிலை',
        admin_sos_h:'🚨 SOS அவசர பதிவுகள்', th_lat:'அட்சரேகை', th_lng:'தீர்க்கரேகை', th_action:'செயல்', th_timestamp:'நேர முத்திரை',
        admin_reports_h:'📋 ஆபத்து புகார்கள்', footer_admin:'ResQNet நிர்வாகி | கட்டுப்படுத்தப்பட்ட அணுகல்',
        login_hero_h:'உள்நுழை அல்லது பதிவு செய்', login_hero_p:'SOS தூண்டப்படும்போது உங்கள் அவசர தொடர்பிற்கு SMS எச்சரிக்கையை இயக்க கணக்கு உருவாக்கவும்.',
        btn_login_tab:'உள்நுழை', btn_register_tab:'பதிவு செய்', login_form_h:'ResQNet இல் உள்நுழையவும்',
        lbl_email:'மின்னஞ்சல்', lbl_password:'கடவுச்சொல்', btn_login:'உள்நுழை',
        register_form_h:'கணக்கு உருவாக்கு', lbl_name:'முழு பெயர்', lbl_phone:'தொலைபேசி எண்',
        lbl_emergency:'அவசர தொடர்பு எண்', btn_register:'கணக்கு உருவாக்கு',
        footer_login:'ResQNet AI | IIT மதராஸ் ஹேக்கதான் 2026',
        // Women's Safety
        ws_btn:'👩 பெண்கள் பாதுகாப்பு', ws_title:'பெண்கள் பாதுகாப்பு — பாதுகாப்பான பயண பயன்முறை',
        ws_dest:'சேருமிடம்', ws_transport:'போக்குவரத்து வகை', ws_vehicle:'வாகன எண்',
        ws_driver:'ஓட்டுநர் பெயர் (விருப்பம்)', ws_arrival:'எதிர்பார்க்கப்பட்ட வருகை நேரம்',
        ws_start:'🛡️ பாதுகாப்பான பயணம் தொடங்கு', ws_monitoring:'🟢 பயண கண்காணிப்பு செயலில்',
        ws_safe_q:'நீங்கள் பாதுகாப்பாக இருக்கிறீர்களா?', ws_yes:'✅ ஆம், நான் பாதுகாப்பாக இருக்கிறேன்', ws_no:'🆘 இல்லை — உதவி!',
        ws_emergency:'🚨 அவசர பயன்முறை செயல்படுத்தப்பட்டது', ws_scan_ocr:'📷 வாகன எண் ஸ்கேன் செய்',
        ws_shake:'📱 Shake-to-SOS செயலில்', ws_checkin:'பாதுகாப்பான வருகை சரிபார்ப்பு',
        ws_arrived:'✅ நான் பாதுகாப்பாக வந்துவிட்டேன்', ws_not_arrived:'🆘 எனக்கு உதவி வேண்டும்',
        ws_dash_h:'பாதுகாப்பு டாஷ்போர்டு', ws_total:'மொத்த பயணங்கள்',
        ws_safe:'பாதுகாப்பான வருகைகள்', ws_emg_count:'அவசர செயல்பாடுகள்',
        ws_nearby_police:'அருகிலுள்ள போலீஸ் நிலையங்கள்', ws_nearby_hosp:'அருகிலுள்ள மருத்துவமனைகள்',
        ws_transport_bus:'பஸ்', ws_transport_auto:'ஆட்டோ', ws_transport_cab:'கேப்',
        ws_transport_train:'ரயில்', ws_transport_metro:'மெட்ரோ', ws_transport_pvt:'தனியார் வாகனம்',
        ws_stop_journey:'⏹ பயணம் முடி', ws_rec_active:'🔴 சான்று பதிவு நடைபெறுகிறது...',
        ws_medical:'அவசர மருத்துவ சுயவிவரம்', ws_blood:'இரத்த வகை',
        ws_allergies:'ஒவ்வாமைகள்', ws_emg_contact:'அவசர தொடர்பு',
        ws_med_notes:'மருத்துவ குறிப்புகள்',
    },
    hi: {
        home:'होम', dashboard:'डैशबोर्ड', nav_sos:'आपातकाल', nav_report:'खतरा रिपोर्ट',
        nav_login:'लॉगिन / रजिस्टर', nav_logout:'लॉगआउट', nav_admin:'व्यवस्थापक',
        tagline:'अनुमान। सुरक्षा। प्रतिक्रिया।',
        hero_index_h:'AI-संचालित सड़क आपातकालीन प्रतिक्रिया',
        hero_index_p:'स्मार्ट बचाव समन्वय, दुर्घटना रोकथाम और नागरिक सड़क सुरक्षा — एक ही प्लेटफ़ॉर्म पर।',
        btn_launch_dashboard:'डैशबोर्ड खोलें', btn_emergency_sos:'आपातकालीन SOS',
        stat_fatalities:'भारत में वार्षिक सड़क मृत्यु', stat_delayed:'विलंबित बचाव से मौतें',
        stat_access:'आपातकालीन प्रतिक्रिया पहुँच', stat_ambulance:'औसत एम्बुलेंस आगमन',
        feat_locator_h:'आपातकालीन लोकेटर', feat_locator_p:'OpenStreetMap का उपयोग करके नजदीकी ट्रॉमा सेंटर और पुलिस स्टेशन तुरंत खोजें।',
        feat_sos_h:'एक-टैप SOS', feat_sos_p:'लाइव GPS के साथ आपातकालीन अलर्ट ट्रिगर करें।',
        feat_ai_h:'AI गंभीरता पहचान', feat_ai_p:'लाइव मौसम, गति, सड़क प्रकार और दिन के समय का उपयोग करके दुर्घटना की गंभीरता का अनुमान लगाता है।',
        feat_hazard_h:'खतरा रिपोर्टिंग', feat_hazard_p:'गड्ढे, टूटे सिग्नल और बाढ़ क्षेत्रों को फोटो प्रमाण और GPS टैगिंग के साथ रिपोर्ट करें।',
        feat_blackspot_h:'ब्लैकस्पॉट हीटमैप', feat_blackspot_p:'लाइव मैप पर समूहित खतरा रिपोर्टों से स्वचालित रूप से पहचाने गए दुर्घटना ब्लैकस्पॉट।',
        feat_whatsapp_h:'WhatsApp SOS शेयर', feat_whatsapp_p:'SOS ट्रिगर होने पर WhatsApp के माध्यम से परिवार को तुरंत GPS स्थान साझा करें।',
        footer_index:'ResQNet AI | सड़क सुरक्षा हैकाथॉन 2026 | IIT मद्रास',
        sos:'🆘 SOS भेजें', hero_sos_h:'तत्काल बचाव सक्रियण',
        hero_sos_p:'लाइव GPS, आपके आपातकालीन संपर्क को SMS अलर्ट और वास्तविक नजदीकी सेवाओं के साथ एक-टैप आपातकालीन प्रतिक्रिया।',
        stat_ambulance_num:'एम्बुलेंस', stat_gps:'GPS ट्रैकिंग', stat_emergency_access:'आपातकालीन पहुँच',
        stat_police:'पुलिस हेल्पलाइन', stat_national:'राष्ट्रीय आपातकाल',
        nearby_services_h:'🚑 नजदीकी आपातकालीन सेवाएं', footer_sos:'मिनट बचाना जीवन बचाना है | ResQNet AI',
        hero_report_h:'नागरिक सड़क सुरक्षा', hero_report_p:'गड्ढे, क्षतिग्रस्त सड़कें, बाढ़ क्षेत्र और दुर्घटनाओं को फोटो प्रमाण के साथ रिपोर्ट करें।',
        submit_hazard_h:'📝 खतरा रिपोर्ट सबमिट करें', lbl_hazard_type:'खतरे का प्रकार',
        opt_select:'-- खतरे का प्रकार चुनें --', opt_pothole:'गड्ढा', opt_signal:'टूटा सिग्नल',
        opt_flood:'बाढ़ क्षेत्र', opt_road_damage:'सड़क क्षति', opt_accident:'दुर्घटना स्थल', opt_other:'अन्य',
        lbl_location:'स्थान विवरण', lbl_photo:'📷 फोटो प्रमाण (वैकल्पिक)', report:'रिपोर्ट सबमिट करें',
        ai_predictor_h:'🤖 AI दुर्घटना गंभीरता भविष्यवक्ता', lbl_speed:'गति (किमी/घंटा)', lbl_weather:'मौसम',
        opt_clear:'साफ', opt_rain:'बारिश', opt_fog:'कोहरा', opt_storm:'तूफान', opt_cloudy:'बादल',
        lbl_road_type:'सड़क प्रकार', opt_urban:'शहरी', opt_highway:'राजमार्ग', opt_rural:'ग्रामीण',
        lbl_hour:'दिन का घंटा (0–23)', predict_btn:'🤖 गंभीरता अनुमान लगाएं',
        footer_report:'नागरिक कार्रवाई के माध्यम से सुरक्षित सड़कें | ResQNet AI',
        hero_dash_h:'रियल-टाइम आपातकालीन जानकारी', hero_dash_p:'लाइव दुर्घटना निगरानी, बचाव सेवा लोकेटर और AI ब्लैकस्पॉट पहचान।',
        stat_risk:'वर्तमान जोखिम स्तर', stat_hazards:'रिपोर्ट किए गए खतरे', stat_active_sos:'सक्रिय SOS अलर्ट',
        stat_amb_help:'एम्बुलेंस हेल्पलाइन', stat_pol_help:'पुलिस हेल्पलाइन',
        dash_hospital_h:'लाइव अस्पताल लोकेटर', dash_hospital_p:'OpenStreetMap के माध्यम से दूरी और फोन नंबरों के साथ वास्तविक अस्पताल।',
        dash_ambulance_h:'एम्बुलेंस ETA', dash_ambulance_p:'आपकी GPS दूरी से गणना किया गया अनुमानित आगमन समय।',
        dash_blackspot_h:'ब्लैकस्पॉट हीटमैप', dash_blackspot_p:'समूहित नागरिक रिपोर्टों से स्वचालित रूप से पहचाने गए खतरे क्षेत्र।',
        dash_export_h:'रिपोर्ट निर्यात करें', export_csv:'📥 CSV', export_pdf:'📄 PDF',
        map_heading:'📍 लाइव आपातकालीन मानचित्र', reports_heading:'📋 हाल की खतरा रिपोर्टें',
        th_id:'क्रमांक', th_hazard_type:'खतरे का प्रकार', th_location:'स्थान', th_status:'स्थिति', th_reported_at:'रिपोर्ट समय',
        footer_dash:'ResQNet AI डैशबोर्ड | IIT मद्रास हैकाथॉन 2026',
        admin_tagline:'व्यवस्थापक पैनल', admin_hero_h:'🛡️ व्यवस्थापक नियंत्रण पैनल',
        admin_hero_p:'SOS अलर्ट प्रबंधित करें, खतरा रिपोर्टें हल करें और डेटा निर्यात करें।',
        admin_export_csv:'📥 CSV निर्यात', admin_export_pdf:'📄 PDF निर्यात',
        stat_total_hazards:'कुल खतरे', stat_active_sos_admin:'सक्रिय SOS', stat_risk_admin:'जोखिम स्तर',
        admin_sos_h:'🚨 SOS आपातकालीन लॉग', th_lat:'अक्षांश', th_lng:'देशांतर', th_action:'कार्रवाई', th_timestamp:'समय',
        admin_reports_h:'📋 खतरा रिपोर्टें', footer_admin:'ResQNet व्यवस्थापक | प्रतिबंधित पहुँच',
        login_hero_h:'लॉगिन या रजिस्टर करें', login_hero_p:'SOS ट्रिगर होने पर आपके आपातकालीन संपर्क को SMS अलर्ट सक्षम करने के लिए खाता बनाएं।',
        btn_login_tab:'लॉगिन', btn_register_tab:'रजिस्टर', login_form_h:'ResQNet में लॉगिन करें',
        lbl_email:'ईमेल', lbl_password:'पासवर्ड', btn_login:'लॉगिन',
        register_form_h:'खाता बनाएं', lbl_name:'पूरा नाम', lbl_phone:'फोन नंबर',
        lbl_emergency:'आपातकालीन संपर्क नंबर', btn_register:'खाता बनाएं',
        footer_login:'ResQNet AI | IIT मद्रास हैकाथॉन 2026',
        // Women's Safety
        ws_btn:'👩 महिला सुरक्षा', ws_title:'महिला सुरक्षा — सुरक्षित यात्रा मोड',
        ws_dest:'गंतव्य', ws_transport:'परिवहन प्रकार', ws_vehicle:'वाहन संख्या',
        ws_driver:'ड्राइवर का नाम (वैकल्पिक)', ws_arrival:'अनुमानित आगमन समय',
        ws_start:'🛡️ सुरक्षित यात्रा शुरू करें', ws_monitoring:'🟢 यात्रा निगरानी सक्रिय',
        ws_safe_q:'क्या आप सुरक्षित हैं?', ws_yes:'✅ हाँ, मैं सुरक्षित हूँ', ws_no:'🆘 नहीं — मदद!',
        ws_emergency:'🚨 आपातकालीन मोड सक्रिय', ws_scan_ocr:'📷 वाहन संख्या स्कैन करें',
        ws_shake:'📱 Shake-to-SOS सक्रिय', ws_checkin:'सुरक्षित चेक-इन',
        ws_arrived:'✅ मैं सुरक्षित पहुंच गई', ws_not_arrived:'🆘 मुझे मदद चाहिए',
        ws_dash_h:'सुरक्षा डैशबोर्ड', ws_total:'कुल यात्राएं',
        ws_safe:'सुरक्षित आगमन', ws_emg_count:'आपातकालीन सक्रियण',
        ws_nearby_police:'नजदीकी पुलिस स्टेशन', ws_nearby_hosp:'नजदीकी अस्पताल',
        ws_transport_bus:'बस', ws_transport_auto:'ऑटो', ws_transport_cab:'कैब',
        ws_transport_train:'ट्रेन', ws_transport_metro:'मेट्रो', ws_transport_pvt:'निजी वाहन',
        ws_stop_journey:'⏹ यात्रा समाप्त करें', ws_rec_active:'🔴 साक्ष्य रिकॉर्डिंग...',
        ws_medical:'आपातकालीन चिकित्सा प्रोफाइल', ws_blood:'रक्त समूह',
        ws_allergies:'एलर्जी', ws_emg_contact:'आपातकालीन संपर्क',
        ws_med_notes:'चिकित्सा नोट्स',
    }
};

function setLanguage(lang) {
    localStorage.setItem('resqnet_lang', lang);
    const t = translations[lang] || translations.en;

    // Nav
    document.querySelectorAll('nav a').forEach(a => {
        const href = a.getAttribute('href');
        const oc   = a.getAttribute('onclick') || '';
        if (href==='/')          a.textContent = t.home;
        if (href==='/dashboard') a.textContent = t.dashboard;
        if (href==='/sos')       a.textContent = t.nav_sos;
        if (href==='/report')    a.textContent = t.nav_report;
        if (href==='/login')     a.textContent = t.nav_login;
        if (href==='/admin')     a.textContent = t.nav_admin;
        if (oc.includes('logout')) a.textContent = t.nav_logout;
    });
    document.querySelectorAll('.tagline').forEach(el => { if (t.tagline) el.textContent = t.tagline; });

    // Hero sections
    document.querySelectorAll('.hero h2').forEach(h2 => {
        const txt = h2.textContent.trim();
        if (txt.includes('Rescue')||txt.includes('மீட்பு')||txt.includes('बचाव')) h2.textContent = t.hero_sos_h;
        else if (txt.includes('Citizen')||txt.includes('குடிமக்கள்')||txt.includes('नागरिक')) h2.textContent = t.hero_report_h;
        else if (txt.includes('Login')||txt.includes('உள்நுழை')||txt.includes('लॉगिन')) h2.textContent = t.login_hero_h;
        else if (txt.includes('Admin')||txt.includes('நிர்வாக')||txt.includes('व्यवस्थापक')) h2.textContent = t.admin_hero_h;
        else if (txt.includes('Real-Time')||txt.includes('நேரடி அவசர தகவல்')||txt.includes('रियल-टाइम')) h2.textContent = t.hero_dash_h;
        else h2.textContent = t.hero_index_h;
    });

    // Hero p
    document.querySelectorAll('.hero p').forEach(p => {
        const txt = p.textContent.trim();
        if (txt.includes('Smart rescue')||txt.includes('திறமையான')||txt.includes('स्मार्ट')) p.textContent = t.hero_index_p;
        else if (txt.includes('One-tap emergency')||txt.includes('நேரடி GPS')||txt.includes('लाइव GPS')) p.textContent = t.hero_sos_p;
        else if (txt.includes('potholes')||txt.includes('குழிகள்')||txt.includes('गड्ढे')) p.textContent = t.hero_report_p;
        else if (txt.includes('Live accident')||txt.includes('நேரடி விபத்து')||txt.includes('लाइव दुर्घटना')) p.textContent = t.hero_dash_p;
        else if (txt.includes('Manage SOS')||txt.includes('SOS எச்சரிக்கைகளை')||txt.includes('SOS अलर्ट')) p.textContent = t.admin_hero_p;
        else if (txt.includes('Create an account')||txt.includes('கணக்கு உருவாக்கவும்')||txt.includes('खाता बनाएं')) p.textContent = t.login_hero_p;
    });

    // Feature cards
    const featMap = [
        ['Emergency Locator','அவசர சேவை','आपातकालीन लोकेटर',   'feat_locator_h',  'feat_locator_p'],
        ['One-Tap SOS','ஒரே தட்டு','एक-टैप SOS',               'feat_sos_h',       'feat_sos_p'],
        ['AI Severity','AI தீவிர','AI गंभीरता',                 'feat_ai_h',        'feat_ai_p'],
        ['Hazard Reporting','ஆபத்து புகார','खतरा रिपोर्ट',      'feat_hazard_h',    'feat_hazard_p'],
        ['Blackspot Heatmap','கருப்பு புள்ளி','ब्लैकस्पॉट',     'feat_blackspot_h', 'feat_blackspot_p'],
        ['WhatsApp SOS','WhatsApp SOS','WhatsApp SOS',          'feat_whatsapp_h',  'feat_whatsapp_p'],
        ['Live Hospital','நேரடி மருத்துவமனை','लाइव अस्पताल',   'dash_hospital_h',  'dash_hospital_p'],
        ['Ambulance ETA','ஆம்புலன்ஸ் வருகை','एम्बुलेंस ETA',   'dash_ambulance_h', 'dash_ambulance_p'],
        ['Blackspot Heat','கருப்பு புள்ளி வரைபடம்','ब्लैकस्पॉट हीटमैप', 'dash_blackspot_h','dash_blackspot_p'],
    ];

    document.querySelectorAll('.card').forEach(card => {
        const h3  = card.querySelector('h3');
        const p   = card.querySelector('p');
        if (!h3) return;
        const txt = h3.textContent.trim();
        for (const [en, ta, hi, hKey, pKey] of featMap) {
            if (txt.includes(en) || txt.includes(ta) || txt.includes(hi)) {
                if (t[hKey]) {
                    // Preserve any buttons inside h3
                    const inner = h3.querySelector('div');
                    h3.textContent = t[hKey];
                    if (inner) h3.appendChild(inner);
                }
                if (pKey && p && t[pKey]) p.textContent = t[pKey];
                break;
            }
        }
    });

    // Stat cards
    const statMap = [
        ['Annual Road','இந்தியாவில் ஆண்டு','भारत में वार्षिक',     'stat_fatalities'],
        ['Deaths Due','தாமதமான மீட்பினால்','विलंबित बचाव',         'stat_delayed'],
        ['Emergency Response Access','அவசர மீட்பு அணுகல்','आपातकालीन प्रतिक्रिया पहुँच', 'stat_access'],
        ['Average Ambulance','சராசரி ஆம்புலன்ஸ்','औसत एम्बुलेंस',  'stat_ambulance'],
        ['Current Risk','தற்போதைய','वर्तमान जोखिम',               'stat_risk'],
        ['Hazards Reported','புகாரளிக்கப்பட்ட','रिपोर्ट किए गए',    'stat_hazards'],
        ['Active SOS Alerts','செயலில் உள்ள SOS எச்சரிக்கை','सक्रिय SOS अलर्ट', 'stat_active_sos'],
        ['Ambulance Helpline','ஆம்புலன்ஸ் உதவி','एम्बुलेंस हेल्पलाइन', 'stat_amb_help'],
        ['Police Helpline','போலீஸ் உதவி','पुलिस हेल्पलाइन',        'stat_pol_help'],
        ['GPS Tracking','GPS கண்காணிப்பு','GPS ट्रैकिंग',           'stat_gps'],
        ['Emergency Access','அவசர அணுகல்','आपातकालीन पहुँच',       'stat_emergency_access'],
        ['National Emergency','தேசிய அவசரநிலை','राष्ट्रीय आपातकाल', 'stat_national'],
    ];

    document.querySelectorAll('.stat-card p').forEach(p => {
        const txt = p.textContent.trim();
        for (const [en, ta, hi, key] of statMap) {
            if (txt.includes(en) || txt.includes(ta) || txt.includes(hi)) {
                if (t[key]) { p.textContent = t[key]; break; }
            }
        }
    });

    // Nav buttons
    document.querySelectorAll('a.btn[href="/dashboard"]').forEach(a => a.textContent = t.btn_launch_dashboard);
    document.querySelectorAll('a.btn[href="/sos"]').forEach(a => { if (!a.id) a.textContent = t.btn_emergency_sos; });

    // Buttons
    const reportBtn  = document.querySelector('#hazard-form [type="submit"]');
    if (reportBtn)   reportBtn.textContent = t.report;
    const predictBtn = document.querySelector('[onclick="predictSeverity()"]');
    if (predictBtn)  predictBtn.textContent = t.predict_btn;
    document.querySelectorAll('[onclick="exportCSV()"]').forEach(b => b.textContent = t.export_csv);
    document.querySelectorAll('[onclick="exportPDF()"]').forEach(b => b.textContent = t.export_pdf);

    // Dropdowns
    document.querySelectorAll('#hazardType option').forEach(opt => {
        const omap = {'':'opt_select','Pothole':'opt_pothole','Broken Signal':'opt_signal','Flood Zone':'opt_flood','Road Damage':'opt_road_damage','Accident Spot':'opt_accident','Other':'opt_other'};
        if (omap[opt.value] && t[omap[opt.value]]) opt.textContent = t[omap[opt.value]];
    });
    document.querySelectorAll('#weather option').forEach(opt => {
        const omap = {'clear':'opt_clear','rain':'opt_rain','fog':'opt_fog','storm':'opt_storm','cloudy':'opt_cloudy'};
        if (omap[opt.value] && t[omap[opt.value]]) opt.textContent = t[omap[opt.value]];
    });
    document.querySelectorAll('#road_type option').forEach(opt => {
        const omap = {'urban':'opt_urban','highway':'opt_highway','rural':'opt_rural'};
        if (omap[opt.value] && t[omap[opt.value]]) opt.textContent = t[omap[opt.value]];
    });

    // Table headers
    document.querySelectorAll('th').forEach(th => {
        const thmap = {'ID':'th_id','Hazard Type':'th_hazard_type','Location':'th_location','Status':'th_status','Reported At':'th_reported_at','Latitude':'th_lat','Longitude':'th_lng','Action':'th_action','Timestamp':'th_timestamp'};
        const allKeys = Object.keys(thmap);
        for (const key of allKeys) {
            if ([key, translations.ta[thmap[key]], translations.hi[thmap[key]]].includes(th.textContent.trim())) {
                if (t[thmap[key]]) { th.textContent = t[thmap[key]]; break; }
            }
        }
    });

    // Footers
    document.querySelectorAll('footer p').forEach(p => {
        const txt = p.textContent;
        if (txt.includes('Road Safety')||txt.includes('சாலை பாதுகாப்பு')||txt.includes('सड़क सुरक्षा')) p.textContent = t.footer_index;
        else if (txt.includes('Saving Minutes')||txt.includes('நிமிடங்கள்')||txt.includes('मिनट बचाना')) p.textContent = t.footer_sos;
        else if (txt.includes('Safer Roads')||txt.includes('குடிமக்கள் செயலால்')||txt.includes('नागरिक कार्रवाई')) p.textContent = t.footer_report;
        else if (txt.includes('Dashboard | IIT')||txt.includes('டாஷ்போர்டு | IIT')||txt.includes('डैशबोर्ड | IIT')) p.textContent = t.footer_dash;
        else if (txt.includes('Restricted')||txt.includes('கட்டுப்படுத்தப்பட்ட')||txt.includes('प्रतिबंधित')) p.textContent = t.footer_admin;
        else if (txt.includes('Hackathon 2026')&&!txt.includes('Dashboard')&&!txt.includes('Road Safety')) p.textContent = t.footer_login;
    });

    document.documentElement.lang = lang;

    // Re-render dynamic table content that uses translated hazard types and status badges
    loadReportsWithTimeline();
    loadAdminReports();

    // Re-render Women's Safety page if active
    if (document.getElementById('ws-main')) wsRenderPage();
}
let trackingInterval = null;
let currentTrackId   = null;

function startLiveTracking() {
    // Generate unique tracking ID
    currentTrackId = 'sos_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

    const trackUrl  = `${window.location.origin}/track/${currentTrackId}`;
    const section   = document.getElementById('tracking-section');
    const linkEl    = document.getElementById('tracking-link');
    const waBtn     = document.getElementById('whatsapp-track-btn');

    if (section) section.style.display = 'block';
    if (linkEl)  { linkEl.textContent = trackUrl; linkEl.href = trackUrl; }

    // WhatsApp share
    if (waBtn) {
        const msg = encodeURIComponent(`🚨 EMERGENCY! Track my live location here: ${trackUrl}`);
        waBtn.href = `https://wa.me/?text=${msg}`;
    }

    // Send location every 10 seconds
    if (trackingInterval) clearInterval(trackingInterval);

    trackingInterval = setInterval(() => {
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(pos => {
            fetch('/api/track/update', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    track_id:  currentTrackId,
                    latitude:  pos.coords.latitude,
                    longitude: pos.coords.longitude
                })
            }).catch(() => {});
        });
    }, 10000);

    console.log("📡 Live tracking started:", currentTrackId);
}

function stopLiveTracking() {
    if (trackingInterval) {
        clearInterval(trackingInterval);
        trackingInterval = null;
    }
}

function copyTrackingLink() {
    if (!currentTrackId) return;
    const url = `${window.location.origin}/track/${currentTrackId}`;
    navigator.clipboard.writeText(url)
        .then(() => alert("✅ Tracking link copied!"))
        .catch(() => alert("Link: " + url));
}
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/static/sw.js')
            .then(reg => console.log('✅ Service Worker registered:', reg.scope))
            .catch(err => console.log('SW registration failed:', err));
    });
}
function analyzePhoto(input) {
    if (!input.files || !input.files[0]) return;

    const file       = input.files[0];
    const analysisEl = document.getElementById('photo-analysis');
    const descEl     = document.getElementById('analysis-description');
    const sevEl      = document.getElementById('analysis-severity');

    if (analysisEl) {
        analysisEl.style.display = 'block';
        if (descEl) descEl.textContent = '🔄 Analyzing photo with AI...';
        if (sevEl)  sevEl.textContent  = '';
    }

    const formData = new FormData();
    formData.append('photo', file);

    fetch('/api/analyze-photo', { method: 'POST', body: formData })
        .then(r => r.json())
        .then(data => {
            if (data.status === 'success') {
                // Show analysis
                if (descEl) descEl.textContent = data.description;

                const colorMap = { Minor: 'lightgreen', Moderate: 'orange', Severe: 'red' };
                if (sevEl) {
                    sevEl.style.color   = colorMap[data.severity] || 'white';
                    sevEl.textContent   = `Severity: ${data.severity}`;
                }

                // Auto-select hazard type dropdown
                const select = document.getElementById('hazardType');
                if (select && data.hazard_type) {
                    const options = Array.from(select.options);
                    const match   = options.find(o => o.value === data.hazard_type);
                    if (match) select.value = data.hazard_type;
                }

                // Speak the result
                speakMessage(`AI detected ${data.hazard_type}. Severity is ${data.severity}. ${data.description}`, localStorage.getItem('resqnet_lang') || 'en');
            }
        })
        .catch(() => {
            if (descEl) descEl.textContent = '❌ Analysis failed. Please select hazard type manually.';
        });
}
// ─────────────────────────────────────────
// FEATURE 6: ROUTE RISK SCORE
// ─────────────────────────────────────────
function checkRouteRisk() {
    const source      = document.getElementById('route-source')?.value.trim();
    const destination = document.getElementById('route-destination')?.value.trim();
    const resultEl    = document.getElementById('route-result');
    const badgeEl     = document.getElementById('route-risk-badge');
    const levelEl     = document.getElementById('route-risk-level');
    const scoreEl     = document.getElementById('route-risk-score');
    const adviceEl    = document.getElementById('route-advice');
    const spotsEl     = document.getElementById('route-spots');

    if (!source || !destination) {
        alert('Please enter both source and destination!');
        return;
    }

    if (levelEl) levelEl.textContent = '🔄 Analyzing route...';
    if (resultEl) resultEl.style.display = 'block';

    fetch('/api/route-risk', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ source, destination })
    })
    .then(r => r.json())
    .then(data => {
        if (data.status === 'error') {
            if (levelEl) levelEl.textContent = '❌ ' + data.message;
            return;
        }

        // Color badge
        const bgMap = { HIGH: '#3a0000', MODERATE: '#3a2000', LOW: '#003a00' };
        if (badgeEl) badgeEl.style.background = bgMap[data.risk_level] || '#16213e';

        if (levelEl) {
            levelEl.style.color   = data.risk_color;
            levelEl.textContent   = `${data.risk_level} RISK`;
        }
        if (scoreEl) scoreEl.textContent = `${data.risk_score} hazard(s) detected along this route`;
        if (adviceEl) adviceEl.textContent = data.advice;

        // Show hazard spots
        if (spotsEl) {
            if (data.risk_spots.length === 0) {
                spotsEl.innerHTML = '<p style="color:lightgreen;">✅ No known hazards on this route.</p>';
            } else {
                spotsEl.innerHTML = data.risk_spots.map(s =>
                    `<div style="background:#0b0f1a; padding:10px; border-radius:6px; margin-bottom:8px; border-left:3px solid orange;">
                        ⚠️ <strong style="color:orange;">${s.type}</strong>
                        <span style="color:#aaa; font-size:12px;"> — ${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}</span>
                    </div>`
                ).join('');
            }
        }

        // Draw route on map
        if (map && data.src_coords && data.dst_coords) {
            // Source marker
            L.marker([data.src_coords.lat, data.src_coords.lng], {
                icon: L.divIcon({
                    className: '',
                    html: '<div style="background:green;color:white;padding:4px 8px;border-radius:4px;font-size:12px;font-weight:bold;">START</div>'
                })
            }).addTo(map).bindPopup(`📍 ${data.source}`);

            // Destination marker
            L.marker([data.dst_coords.lat, data.dst_coords.lng], {
                icon: L.divIcon({
                    className: '',
                    html: '<div style="background:red;color:white;padding:4px 8px;border-radius:4px;font-size:12px;font-weight:bold;">END</div>'
                })
            }).addTo(map).bindPopup(`🏁 ${data.destination}`);

            // Draw route line
            if (data.route_coords && data.route_coords.length > 0) {
                const latlngs = data.route_coords.map(c => [c[1], c[0]]);
                L.polyline(latlngs, { color: data.risk_color, weight: 4, opacity: 0.8 }).addTo(map);
            } else {
                // Simple straight line if no route data
                L.polyline([
                    [data.src_coords.lat, data.src_coords.lng],
                    [data.dst_coords.lat, data.dst_coords.lng]
                ], { color: data.risk_color, weight: 4, opacity: 0.8, dashArray: '10,10' }).addTo(map);
            }

            // Fit map to show full route
            map.fitBounds([
                [data.src_coords.lat, data.src_coords.lng],
                [data.dst_coords.lat, data.dst_coords.lng]
            ], { padding: [50, 50] });
        }

        // Speak result
        speakMessage(data.advice, localStorage.getItem('resqnet_lang') || 'en');
    })
    .catch(() => {
        if (levelEl) levelEl.textContent = '❌ Could not analyze route. Check internet connection.';
    });
}
// ─────────────────────────────────────────
// FEATURE 9: ADMIN ROLE MANAGEMENT
// ─────────────────────────────────────────
function loadAdminUsers() {
    const tbody = document.getElementById('users-body');
    if (!tbody) return;

    fetch('/api/admin/users', { headers: authHeaders() })
        .then(r => r.json())
        .then(data => {
            if (!data.length) {
                tbody.innerHTML = '<tr><td colspan="6" style="padding:20px;color:#aaa;">No users yet.</td></tr>';
                return;
            }
            tbody.innerHTML = data.map(u => `
                <tr>
                    <td>${u.id}</td>
                    <td>${u.name}</td>
                    <td>${u.email}</td>
                    <td>${u.phone || 'N/A'}</td>
                    <td>
                        <span style="background:${u.role === 'admin' ? '#1a3a2a' : '#16213e'};
                            color:${u.role === 'admin' ? 'lightgreen' : '#aaa'};
                            padding:4px 12px; border-radius:20px; font-size:13px;">
                            ${u.role === 'admin' ? '🛡️ Admin' : '👤 User'}
                        </span>
                    </td>
                    <td>
                        ${u.role === 'admin'
                            ? `<button class="btn" style="padding:4px 10px;font-size:12px;background:darkred;" onclick="demoteUser(${u.id})">Demote</button>`
                            : `<button class="btn" style="padding:4px 10px;font-size:12px;background:green;"  onclick="promoteUser(${u.id})">Promote</button>`
                        }
                    </td>
                </tr>`).join('');
        })
        .catch(() => {
            if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="color:#aaa;">Could not load users.</td></tr>';
        });
}

function promoteUser(id) {
    if (!confirm('Promote this user to Admin?')) return;
    fetch(`/api/admin/promote/${id}`, { method: 'POST', headers: authHeaders() })
        .then(r => r.json())
        .then(data => {
            alert('✅ ' + data.message);
            loadAdminUsers();
        })
        .catch(() => alert('❌ Failed to promote user.'));
}

function demoteUser(id) {
    if (!confirm('Demote this admin to User?')) return;
    fetch(`/api/admin/demote/${id}`, { method: 'POST', headers: authHeaders() })
        .then(r => r.json())
        .then(data => {
            alert('✅ ' + data.message);
            loadAdminUsers();
        })
        .catch(() => alert('❌ Failed to demote user.'));
}
// ─────────────────────────────────────────
// FEATURE 10: HAZARD STATUS TIMELINE
// ─────────────────────────────────────────
// Hazard type translations for table body
const hazardTypeTranslations = {
    en: { 'Pothole':'Pothole','Broken Signal':'Broken Signal','Flood Zone':'Flood Zone','Road Damage':'Road Damage','Accident Spot':'Accident Spot','Other':'Other' },
    ta: { 'Pothole':'குழி','Broken Signal':'உடைந்த சிக்னல்','Flood Zone':'வெள்ளப் பகுதி','Road Damage':'சாலை சேதம்','Accident Spot':'விபத்து இடம்','Other':'மற்றவை' },
    hi: { 'Pothole':'गड्ढा','Broken Signal':'टूटा सिग्नल','Flood Zone':'बाढ़ क्षेत्र','Road Damage':'सड़क क्षति','Accident Spot':'दुर्घटना स्थल','Other':'अन्य' }
};

const statusTranslations = {
    en: { open:'Open', investigating:'Investigating', resolved:'Resolved' },
    ta: { open:'திறந்தது', investigating:'விசாரணையில்', resolved:'தீர்க்கப்பட்டது' },
    hi: { open:'खुला', investigating:'जांच में', resolved:'हल किया' }
};

function getTimelineBadge(status) {
    const lang  = localStorage.getItem('resqnet_lang') || 'en';
    const sLabels = statusTranslations[lang] || statusTranslations.en;
    const steps = ['open', 'investigating', 'resolved'];
    const colors = {
        open:          '#e74c3c',
        investigating: '#e67e22',
        resolved:      '#2ecc71'
    };
    const icons = {
        open:          '🔴',
        investigating: '🟠',
        resolved:      '🟢'
    };

    return `
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
            ${steps.map(step => `
                <div style="display:flex; align-items:center; gap:4px;">
                    <span style="
                        background:${status === step ? colors[step] : '#333'};
                        color:white;
                        padding:3px 10px;
                        border-radius:20px;
                        font-size:11px;
                        font-weight:${status === step ? 'bold' : 'normal'};
                        opacity:${status === step ? '1' : '0.4'};">
                        ${icons[step]} ${sLabels[step] || step.charAt(0).toUpperCase() + step.slice(1)}
                    </span>
                    ${step !== 'resolved' ? '<span style="color:#555;">→</span>' : ''}
                </div>
            `).join('')}
        </div>`;
}

function loadAdminReports() {
    const tbody = document.getElementById('admin-reports-body');
    if (!tbody) return;

    fetch('/api/reports/timeline', { headers: authHeaders() })
        .then(r => r.json())
        .then(data => {
            if (!data.length) {
                tbody.innerHTML = '<tr><td colspan="6" style="padding:20px;color:#aaa;">No reports yet.</td></tr>';
                return;
            }
            tbody.innerHTML = data.map(row => `
                <tr id="report-row-${row.id}">
                    <td>${row.id}</td>
                    <td>${row.hazard_type}</td>
                    <td>${row.location}</td>
                    <td>${getTimelineBadge(row.status || 'open')}</td>
                    <td>${row.timestamp ? row.timestamp.split('.')[0] : 'N/A'}</td>
                    <td>
                        <select onchange="updateHazardStatus(${row.id}, this.value)"
                            style="background:#0b0f1a; color:white; padding:6px; border-radius:6px; border:1px solid #333;">
                            <option value="open"          ${row.status==='open'          ? 'selected' : ''}>🔴 Open</option>
                            <option value="investigating" ${row.status==='investigating' ? 'selected' : ''}>🟠 Investigating</option>
                            <option value="resolved"      ${row.status==='resolved'      ? 'selected' : ''}>🟢 Resolved</option>
                        </select>
                    </td>
                </tr>`).join('');
        })
        .catch(() => {
            if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="color:#aaa;">Could not load reports.</td></tr>';
        });
}

function updateHazardStatus(id, status) {
    fetch(`/api/admin/update-status/${id}`, {
        method:  'POST',
        headers: authHeaders(),
        body:    JSON.stringify({ status })
    })
    .then(r => r.json())
    .then(data => {
        if (data.status === 'success') {
            // Refresh the row
            loadAdminReports();
        }
    })
    .catch(() => alert('❌ Failed to update status.'));
}

// Also update dashboard reports table to show timeline
function loadReportsWithTimeline() {
    const tbody = document.getElementById('reports-body');
    if (!tbody) return;

    fetch('/api/reports/timeline')
        .then(r => r.json())
        .then(data => {
            if (!data.length) {
                tbody.innerHTML = '<tr><td colspan="5" style="padding:20px;color:#aaa;">No reports yet.</td></tr>';
                return;
            }
            const lang = localStorage.getItem('resqnet_lang') || 'en';
            const hMap = hazardTypeTranslations[lang] || hazardTypeTranslations.en;
            tbody.innerHTML = data.map(row => `
                <tr>
                    <td>${row.id}</td>
                    <td>${hMap[row.hazard_type] || row.hazard_type}</td>
                    <td>${row.location}</td>
                    <td>${getTimelineBadge(row.status || 'open')}</td>
                    <td>${row.timestamp ? row.timestamp.split('.')[0] : 'N/A'}</td>
                </tr>`).join('');
        })
        .catch(() => {
            if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="color:#aaa;">Could not load.</td></tr>';
        });
}
// ─────────────────────────────────────────
// FALLBACK LOCATION METHODS
// ─────────────────────────────────────────
function getIPLocation() {
    return fetch('https://ipapi.co/json/')
        .then(r => r.json())
        .then(data => ({
            latitude:  data.latitude,
            longitude: data.longitude,
            city:      data.city,
            accurate:  false
        }))
        .catch(() => null);
}

function requestLocation() {
    navigator.geolocation.getCurrentPosition(
        () => {
            const warn = document.getElementById('location-warning');
            if (warn) warn.style.display = 'none';
        },
        () => alert('Please enable location in your browser/phone settings.')
    );
}

function sendSOSManual() {
    const location = document.getElementById('manual-loc-input')?.value.trim();
    const statusEl = document.getElementById('sos-status');
    if (!location) { alert('Please enter your location!'); return; }

    if (statusEl) { statusEl.style.color = 'yellow'; statusEl.textContent = '🚨 Sending SOS...'; }

    fetch('/api/sos', {
        method:  'POST',
        headers: authHeaders(),
        body:    JSON.stringify({ latitude: null, longitude: null, manual_location: location })
    })
    .then(r => r.json())
    .then(data => {
        if (statusEl) {
            statusEl.style.color   = 'lightgreen';
            statusEl.textContent   = `✅ SOS Sent! Location: ${location}`;
        }
        showServices(data.nearby_services);
        startLiveTracking();
    })
    .catch(() => {
        if (statusEl) { statusEl.style.color = 'red'; statusEl.textContent = '❌ Failed. Call 108!'; }
    });
}

// ═══════════════════════════════════════════════════════════
// WOMEN'S SAFETY — SAFE JOURNEY MODE
// ═══════════════════════════════════════════════════════════

let wsJourneyActive      = false;
let wsEmergencyMode      = false;
let wsGpsInterval        = null;
let wsSafetyCheckTimer   = null;
let wsCheckInTimer       = null;
let wsShakeCount         = 0;
let wsShakeTimer         = null;
let wsMediaRecorder      = null;
let wsRecordedChunks     = [];
let wsLastLat            = null;
let wsLastLng            = null;
let wsJourneyPath        = [];
let wsRouteDeviationCount= 0;
let wsLongStopTimer      = null;
let wsLastMoveTime       = Date.now();
let wsVoiceRecognition   = null;
let wsFlashInterval      = null;
let wsSirenAudio         = null;

// ── Safety Dashboard counters (localStorage) ─────────────────
function wsGetDash() {
    return JSON.parse(localStorage.getItem('ws_dashboard') || '{"total":0,"safe":0,"emergency":0,"history":[]}');
}
function wsSaveDash(d) { localStorage.setItem('ws_dashboard', JSON.stringify(d)); }

// ── Journey store ─────────────────────────────────────────────
function wsGetJourney() { return JSON.parse(localStorage.getItem('ws_journey') || 'null'); }
function wsSetJourney(j) { localStorage.setItem('ws_journey', JSON.stringify(j)); }
function wsClearJourney() { localStorage.removeItem('ws_journey'); }

// ── Medical profile ───────────────────────────────────────────
function wsGetMedical() { return JSON.parse(localStorage.getItem('ws_medical') || '{}'); }
function wsSaveMedical(m) { localStorage.setItem('ws_medical', JSON.stringify(m)); }

// ── Render Women's Safety page content ───────────────────────
function wsRenderPage() {
    const container = document.getElementById('ws-main');
    if (!container) return;
    const lang = localStorage.getItem('resqnet_lang') || 'en';
    const t = (translations[lang] || translations.en);
    const dash = wsGetDash();
    const med  = wsGetMedical();
    const journey = wsGetJourney();

    container.innerHTML = `
    <!-- SAFETY DASHBOARD -->
    <div class="ws-section">
        <h2 style="color:#e91e8c;">📊 ${t.ws_dash_h || 'Safety Dashboard'}</h2>
        <div class="ws-stats">
            <div class="ws-stat-card"><h3>${dash.total}</h3><p>${t.ws_total||'Total Journeys'}</p></div>
            <div class="ws-stat-card safe"><h3>${dash.safe}</h3><p>${t.ws_safe||'Safe Arrivals'}</p></div>
            <div class="ws-stat-card danger"><h3>${dash.emergency}</h3><p>${t.ws_emg_count||'Emergency Activations'}</p></div>
        </div>
    </div>

    <!-- MEDICAL PROFILE -->
    <div class="ws-section">
        <h2 style="color:#e91e8c;">🩺 ${t.ws_medical||'Emergency Medical Profile'}</h2>
        <div class="ws-form" id="ws-medical-form">
            <input id="ws-blood" class="ws-input" placeholder="🩸 ${t.ws_blood||'Blood Group'}" value="${med.blood||''}">
            <input id="ws-allergies" class="ws-input" placeholder="⚠️ ${t.ws_allergies||'Allergies'}" value="${med.allergies||''}">
            <input id="ws-emg-contact" class="ws-input" placeholder="📞 ${t.ws_emg_contact||'Emergency Contact'}" value="${med.contact||''}">
            <textarea id="ws-med-notes" class="ws-input" rows="2" placeholder="📝 ${t.ws_med_notes||'Medical Notes'}" style="resize:none;">${med.notes||''}</textarea>
            <button class="ws-btn-secondary" onclick="wsSaveMedicalProfile()">💾 Save Profile</button>
        </div>
    </div>

    <!-- JOURNEY REGISTRATION -->
    <div class="ws-section" id="ws-registration" style="${wsJourneyActive ? 'display:none' : ''}">
        <h2 style="color:#e91e8c;">🛡️ ${t.ws_start||'Start Safe Journey'}</h2>
        <div class="ws-form">
            <input id="ws-dest" class="ws-input" placeholder="📍 ${t.ws_dest||'Destination'}">
            <select id="ws-transport" class="ws-input">
                <option value="">🚗 ${t.ws_transport||'Transport Type'}</option>
                <option value="Bus">${t.ws_transport_bus||'Bus'}</option>
                <option value="Auto">${t.ws_transport_auto||'Auto'}</option>
                <option value="Cab">${t.ws_transport_cab||'Cab'}</option>
                <option value="Train">${t.ws_transport_train||'Train'}</option>
                <option value="Metro">${t.ws_transport_metro||'Metro'}</option>
                <option value="Private Vehicle">${t.ws_transport_pvt||'Private Vehicle'}</option>
            </select>
            <div style="display:flex;gap:8px;">
                <input id="ws-vehicle" class="ws-input" style="flex:1;" placeholder="🔢 ${t.ws_vehicle||'Vehicle Number'}">
                <button class="ws-btn-secondary" style="white-space:nowrap;" onclick="wsOCRScan()">${t.ws_scan_ocr||'📷 Scan'}</button>
            </div>
            <input id="ws-driver" class="ws-input" placeholder="👤 ${t.ws_driver||'Driver Name (Optional)'}">
            <input id="ws-arrival" class="ws-input" type="time" placeholder="⏰ ${t.ws_arrival||'Expected Arrival Time'}">
            <button class="ws-btn-primary" onclick="wsStartJourney()">🛡️ ${t.ws_start||'Start Safe Journey'}</button>
        </div>
    </div>

    <!-- ACTIVE JOURNEY PANEL -->
    <div class="ws-section" id="ws-active-panel" style="${wsJourneyActive ? '' : 'display:none'}">
        <div id="ws-status-banner" class="ws-banner monitoring">
            🟢 ${t.ws_monitoring||'Journey Monitoring Active'}
        </div>
        <div id="ws-journey-info" class="ws-journey-info"></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin:16px 0;">
            <button class="ws-btn-danger" onclick="wsActivateEmergency('manual')">🆘 SOS</button>
            <button class="ws-btn-secondary" onclick="wsCheckIn()">✅ ${t.ws_checkin||'Safe Check-In'}</button>
            <button class="ws-btn-stop" onclick="wsEndJourney()">⏹ ${t.ws_stop_journey||'End Journey'}</button>
        </div>
        <div id="ws-gps-coords" style="color:#aaa;font-size:12px;margin-top:8px;"></div>
        <div id="ws-rec-status" style="display:none;color:#ff4444;font-weight:bold;font-size:14px;margin-top:8px;">
            🔴 ${t.ws_rec_active||'Recording Evidence...'}
        </div>
    </div>

    <!-- SAFETY CHECK MODAL -->
    <div id="ws-safety-modal" class="ws-modal" style="display:none;">
        <div class="ws-modal-box">
            <h2 style="font-size:28px;">⚠️ ${t.ws_safe_q||'Are you safe?'}</h2>
            <p style="color:#aaa;margin:10px 0;" id="ws-modal-reason"></p>
            <p style="color:#e91e8c;font-size:20px;font-weight:bold;" id="ws-modal-countdown">30</p>
            <div style="display:flex;gap:12px;justify-content:center;margin-top:20px;">
                <button class="ws-btn-safe" onclick="wsSafetyResponse(true)">${t.ws_yes||'✅ Yes, Safe'}</button>
                <button class="ws-btn-danger" onclick="wsSafetyResponse(false)">${t.ws_no||'🆘 No — HELP!'}</button>
            </div>
        </div>
    </div>

    <!-- EMERGENCY MODAL -->
    <div id="ws-emergency-modal" class="ws-modal" style="display:none;">
        <div class="ws-modal-box emergency-box">
            <h2 style="font-size:26px;color:#ff1744;">🚨 ${t.ws_emergency||'Emergency Mode Activated'}</h2>
            <p style="color:#fff;margin:12px 0;">Recording • Sharing Location • Alerting Contacts</p>
            <div id="ws-emg-details" style="text-align:left;background:#1a0000;padding:12px;border-radius:8px;margin:10px 0;font-size:13px;color:#ffaaaa;"></div>
            <button onclick="wsStopEmergency()" class="ws-btn-secondary" style="margin-top:16px;">⏹ I Am Safe Now</button>
        </div>
    </div>

    <!-- NEARBY SERVICES -->
    <div class="ws-section" id="ws-services" style="display:none;">
        <h2 style="color:#e91e8c;">📍 Nearby Safety Services</h2>
        <div id="ws-services-list" class="ws-services-grid"></div>
    </div>

    <!-- JOURNEY HISTORY -->
    <div class="ws-section">
        <h2 style="color:#e91e8c;">📜 Journey History</h2>
        <div id="ws-history-list">
            ${dash.history.slice(-5).reverse().map(h => `
                <div class="ws-history-row">
                    <span>${h.icon}</span>
                    <span style="flex:1;">${h.dest} • ${h.transport}</span>
                    <span style="color:#aaa;font-size:12px;">${h.time}</span>
                </div>`).join('') || '<p style="color:#555;">No journeys yet.</p>'}
        </div>
    </div>
    `;

    if (wsJourneyActive) wsUpdateJourneyInfo();
}

function wsSaveMedicalProfile() {
    wsSaveMedical({
        blood:     document.getElementById('ws-blood')?.value || '',
        allergies: document.getElementById('ws-allergies')?.value || '',
        contact:   document.getElementById('ws-emg-contact')?.value || '',
        notes:     document.getElementById('ws-med-notes')?.value || ''
    });
    alert('✅ Medical profile saved!');
}

function wsUpdateJourneyInfo() {
    const j = wsGetJourney();
    if (!j) return;
    const el = document.getElementById('ws-journey-info');
    if (el) el.innerHTML = `
        <div class="ws-info-grid">
            <span>📍 <b>${j.destination}</b></span>
            <span>🚗 ${j.transport}</span>
            <span>🔢 ${j.vehicle || '—'}</span>
            <span>👤 ${j.driver || '—'}</span>
            <span>⏰ ETA: ${j.arrivalTime || '—'}</span>
            <span>🕐 Started: ${j.startTime}</span>
        </div>`;
}

// ── Start Journey ─────────────────────────────────────────────
function wsStartJourney() {
    const dest     = document.getElementById('ws-dest')?.value.trim();
    const transport= document.getElementById('ws-transport')?.value;
    const vehicle  = document.getElementById('ws-vehicle')?.value.trim();
    const driver   = document.getElementById('ws-driver')?.value.trim();
    const arrival  = document.getElementById('ws-arrival')?.value;

    if (!dest || !transport) { alert('Please enter destination and transport type.'); return; }

    const journey = {
        destination: dest, transport, vehicle, driver,
        arrivalTime: arrival,
        startTime: new Date().toLocaleTimeString(),
        startTs: Date.now(),
        path: []
    };
    wsSetJourney(journey);
    wsJourneyActive = true;
    wsJourneyPath = []; // reset in-memory path

    // Update dashboard
    const dash = wsGetDash();
    dash.total++;
    wsSaveDash(dash);

    // Show active panel
    document.getElementById('ws-registration').style.display = 'none';
    document.getElementById('ws-active-panel').style.display = '';
    wsUpdateJourneyInfo();

    // Capture first GPS point immediately and draw it
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            const { latitude: lat, longitude: lng } = pos.coords;
            wsLastLat = lat; wsLastLng = lng;
            wsJourneyPath.push([lat, lng]);
            const j = wsGetJourney();
            if (j) { j.path = [[lat, lng, Date.now()]]; wsSetJourney(j); }
            wsPlaceUserMarker(lat, lng);
            if (wsMap) wsMap.setView([lat, lng], 15);
            wsDrawRoutePath();
            wsLoadNearbyServices(lat, lng);
        }, () => {}, { enableHighAccuracy: true });
    }

    // Start GPS watch
    wsStartGPS();
    // Start shake detection
    wsStartShake();
    // Start voice SOS
    wsStartVoiceSOS_WS();
    // Schedule check-in if arrival time given
    if (arrival) wsScheduleCheckIn(arrival);

    wsShowBanner('monitoring', '🟢 Journey monitoring active. Stay safe!');
}

// ── GPS Tracking ──────────────────────────────────────────────
function wsStartGPS() {
    if (!navigator.geolocation) return;

    // Use watchPosition for continuous real-time updates
    wsGpsInterval = navigator.geolocation.watchPosition(pos => {
        const { latitude: lat, longitude: lng } = pos.coords;
        const gpsEl = document.getElementById('ws-gps-coords');
        if (gpsEl) gpsEl.textContent = `📡 GPS: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;

        // Only record a new point if moved >10 metres
        const moved = (!wsLastLat || wsDist(lat, lng, wsLastLat, wsLastLng) > 0.01);
        if (moved) {
            wsJourneyPath.push([lat, lng]);

            // Sync path to localStorage
            const j = wsGetJourney();
            if (j) {
                if (!j.path) j.path = [];
                j.path.push([lat, lng, Date.now()]);
                wsSetJourney(j);
            }

            // Update live map marker and redraw path
            wsPlaceUserMarker(lat, lng);
            wsDrawRoutePath();
        }

        // Long-stop detection (>5 min without movement >50m)
        if (wsLastLat && wsLastLng) {
            const dist = wsDist(lat, lng, wsLastLat, wsLastLng);
            if (dist < 0.05) {
                if (!wsLongStopTimer) {
                    wsLongStopTimer = setTimeout(() => {
                        wsShowSafetyCheck('Unexpected long stop detected.');
                    }, 5 * 60 * 1000);
                }
            } else {
                clearTimeout(wsLongStopTimer);
                wsLongStopTimer = null;
                wsLastMoveTime = Date.now();
            }
        }
        wsLastLat = lat; wsLastLng = lng;

    }, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
}

function wsDist(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2-lat1)*Math.PI/180;
    const dLng = (lng2-lng1)*Math.PI/180;
    const a = Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)*Math.sin(dLng/2);
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// ── Safety Check Modal ────────────────────────────────────────
function wsShowSafetyCheck(reason) {
    if (wsEmergencyMode) return;
    const modal = document.getElementById('ws-safety-modal');
    if (!modal) return;
    const reasonEl = document.getElementById('ws-modal-reason');
    if (reasonEl) reasonEl.textContent = reason || '';
    modal.style.display = 'flex';

    let countdown = 30;
    const countEl = document.getElementById('ws-modal-countdown');
    if (countEl) countEl.textContent = countdown;

    wsSafetyCheckTimer = setInterval(() => {
        countdown--;
        if (countEl) countEl.textContent = countdown;
        if (countdown <= 0) {
            clearInterval(wsSafetyCheckTimer);
            modal.style.display = 'none';
            wsActivateEmergency('no_response');
        }
    }, 1000);
}

function wsSafetyResponse(safe) {
    clearInterval(wsSafetyCheckTimer);
    const modal = document.getElementById('ws-safety-modal');
    if (modal) modal.style.display = 'none';
    if (safe) {
        wsShowBanner('monitoring', '🟢 Great! Continuing to monitor your journey.');
    } else {
        wsActivateEmergency('user_reported_unsafe');
    }
}

// ── Emergency Mode ────────────────────────────────────────────
async function wsActivateEmergency(trigger) {
    if (wsEmergencyMode) return;
    wsEmergencyMode = true;

    const j = wsGetJourney();
    const lat = wsLastLat;
    const lng = wsLastLng;
    const now = new Date();

    // Start camera+mic recording
    wsStartRecording();
    // Flash + siren
    wsActivateFlashAndSiren();
    // Show emergency modal
    wsShowEmergencyModal(j, lat, lng, now, trigger);
    // Share location via backend SOS
    fetch('/api/sos', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
            latitude: lat, longitude: lng,
            manual_location: j ? `${j.destination} — Vehicle: ${j.vehicle||'N/A'} (${j.transport})` : 'Women Safety Emergency'
        })
    }).catch(() => {});

    // Update dashboard
    const dash = wsGetDash();
    dash.emergency++;
    wsSaveDash(dash);

    wsShowBanner('danger', '🚨 Emergency Mode Active — Recording and Alerting');
    const recEl = document.getElementById('ws-rec-status');
    if (recEl) recEl.style.display = 'block';
}

function wsShowEmergencyModal(j, lat, lng, now, trigger) {
    const modal = document.getElementById('ws-emergency-modal');
    const details = document.getElementById('ws-emg-details');
    if (!modal || !details) return;
    const med = wsGetMedical();
    details.innerHTML = `
        <b>📍 Location:</b> ${lat ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : 'N/A'}<br>
        <b>🚗 Transport:</b> ${j?.transport || 'N/A'}<br>
        <b>🔢 Vehicle:</b> ${j?.vehicle || 'N/A'}<br>
        <b>👤 Driver:</b> ${j?.driver || 'N/A'}<br>
        <b>📍 Destination:</b> ${j?.destination || 'N/A'}<br>
        <b>⏰ Time:</b> ${now.toLocaleString()}<br>
        <b>🩸 Blood Group:</b> ${med.blood || 'N/A'}<br>
        <b>📞 Emergency Contact:</b> ${med.contact || 'N/A'}<br>
        <b>⚡ Trigger:</b> ${trigger}`;
    modal.style.display = 'flex';
}

// ── Start Media Recording ─────────────────────────────────────
async function wsStartRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        wsMediaRecorder = new MediaRecorder(stream);
        wsRecordedChunks = [];
        wsMediaRecorder.ondataavailable = e => { if (e.data.size > 0) wsRecordedChunks.push(e.data); };
        wsMediaRecorder.start(1000);
    } catch (err) {
        // Camera/mic denied — log silently; emergency alert still goes through
        console.warn('WS Recording unavailable:', err);
    }
}

function wsStopRecording() {
    if (wsMediaRecorder && wsMediaRecorder.state !== 'inactive') {
        wsMediaRecorder.stop();
        wsMediaRecorder.stream?.getTracks().forEach(t => t.stop());
    }
}

// ── Flash + Siren ─────────────────────────────────────────────
function wsActivateFlashAndSiren() {
    // Flash via screen blink (browser torch API limited)
    let on = true;
    wsFlashInterval = setInterval(() => {
        document.body.style.background = on ? '#ff0000' : '#000000';
        on = !on;
    }, 300);

    // Siren via Web Audio
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        function beep(freq, start, dur) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.8, ctx.currentTime + start);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
            osc.start(ctx.currentTime + start);
            osc.stop(ctx.currentTime + start + dur);
        }
        for (let i = 0; i < 10; i++) { beep(880, i*0.5, 0.4); beep(440, i*0.5+0.25, 0.25); }
    } catch(e) {}
}

function wsStopFlashAndSiren() {
    clearInterval(wsFlashInterval);
    document.body.style.background = '';
}

// ── Stop Emergency ────────────────────────────────────────────
function wsStopEmergency() {
    wsEmergencyMode = false;
    wsStopRecording();
    wsStopFlashAndSiren();
    const modal = document.getElementById('ws-emergency-modal');
    if (modal) modal.style.display = 'none';
    const recEl = document.getElementById('ws-rec-status');
    if (recEl) recEl.style.display = 'none';
    wsShowBanner('monitoring', '🟢 Emergency ended. Monitoring resumed.');
}

// ── Check-In ─────────────────────────────────────────────────
function wsScheduleCheckIn(arrivalTime) {
    const [h, m] = arrivalTime.split(':').map(Number);
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
    let diff = target - now;
    if (diff < 0) diff += 86400000;
    wsCheckInTimer = setTimeout(() => wsShowCheckIn(), diff);
}

function wsShowCheckIn() {
    const lang = localStorage.getItem('resqnet_lang') || 'en';
    const t = (translations[lang] || translations.en);
    const confirmed = confirm(`⏰ ${t.ws_checkin||'Safe Check-In'}\n\n${t.ws_safe_q||'Have you arrived safely?'}`);
    if (confirmed) {
        wsEndJourney();
    } else {
        wsActivateEmergency('checkin_not_confirmed');
    }
}

function wsCheckIn() {
    const lang = localStorage.getItem('resqnet_lang') || 'en';
    const t = (translations[lang] || translations.en);
    const confirmed = confirm(`${t.ws_safe_q||'Are you safe?'}`);
    if (!confirmed) wsActivateEmergency('manual_unsafe');
}

// ── End Journey ───────────────────────────────────────────────
function wsEndJourney() {
    wsJourneyActive = false;
    if (wsGpsInterval !== null) {
        navigator.geolocation.clearWatch(wsGpsInterval);
        wsGpsInterval = null;
    }
    clearTimeout(wsCheckInTimer);
    clearTimeout(wsLongStopTimer);
    clearInterval(wsSafetyCheckTimer);
    if (wsVoiceRecognition) { try { wsVoiceRecognition.stop(); } catch(e){} }

    const j = wsGetJourney();
    const dash = wsGetDash();
    if (!wsEmergencyMode) { dash.safe++; }
    dash.history.push({
        icon: wsEmergencyMode ? '🚨' : '✅',
        dest: j?.destination || '—',
        transport: j?.transport || '—',
        time: new Date().toLocaleString()
    });
    if (dash.history.length > 20) dash.history.shift();
    wsSaveDash(dash);
    wsClearJourney();

    wsStopEmergency();
    document.getElementById('ws-registration').style.display = '';
    document.getElementById('ws-active-panel').style.display = 'none';
    wsShowBanner('monitoring', '✅ Journey ended safely. Thank you!');
    wsRenderPage();
}

// ── Shake to SOS ──────────────────────────────────────────────
function wsStartShake() {
    if (!window.DeviceMotionEvent) return;
    window.addEventListener('devicemotion', wsOnShake);
}

function wsOnShake(e) {
    if (!wsJourneyActive) return;
    const acc = e.accelerationIncludingGravity;
    const total = Math.abs(acc.x) + Math.abs(acc.y) + Math.abs(acc.z);
    if (total > 30) {
        wsShakeCount++;
        clearTimeout(wsShakeTimer);
        wsShakeTimer = setTimeout(() => { wsShakeCount = 0; }, 1500);
        if (wsShakeCount >= 3) {
            wsShakeCount = 0;
            wsActivateEmergency('shake_sos');
        }
    }
}

// ── Voice SOS ─────────────────────────────────────────────────
function wsStartVoiceSOS_WS() {
    if (!window.SpeechRecognition && !window.webkitSpeechRecognition) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    wsVoiceRecognition = new SR();
    wsVoiceRecognition.continuous = true;
    wsVoiceRecognition.lang = 'en-IN';
    wsVoiceRecognition.onresult = e => {
        const transcript = Array.from(e.results).map(r => r[0].transcript).join(' ').toLowerCase();
        if (['help me','help','emergency','bachao','aidez'].some(w => transcript.includes(w))) {
            wsActivateEmergency('voice_sos');
        }
    };
    wsVoiceRecognition.onerror = () => {};
    try { wsVoiceRecognition.start(); } catch(e) {}
}

// ── OCR Vehicle Scan ─────────────────────────────────────────
async function wsOCRScan() {
    if (!navigator.mediaDevices) { alert('Camera not available'); return; }
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const video = document.createElement('video');
        video.srcObject = stream; video.play();
        await new Promise(r => setTimeout(r, 1500));
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        stream.getTracks().forEach(t => t.stop());
        // Use Tesseract.js if available, else prompt
        if (window.Tesseract) {
            const { data: { text } } = await Tesseract.recognize(canvas, 'eng');
            const match = text.match(/[A-Z]{2}\s?\d{2}\s?[A-Z]{1,2}\s?\d{4}/);
            if (match) { document.getElementById('ws-vehicle').value = match[0].replace(/\s/g,''); }
            else alert('Could not read plate. Please enter manually.');
        } else {
            alert('OCR library not loaded. Please enter vehicle number manually.');
        }
    } catch(err) { alert('Camera access denied.'); }
}

// ── Nearby Safety Services ────────────────────────────────────
function wsLoadNearbyServices(lat, lng) {
    const servicesSection = document.getElementById('ws-services');
    const servicesList    = document.getElementById('ws-services-list');
    if (!servicesSection || !servicesList) return;
    servicesSection.style.display = '';

    // Also plot on map
    if (wsMap) wsMapLoadServices(lat, lng);

    const policeQ = `[out:json][timeout:10];node["amenity"="police"](around:5000,${lat},${lng});out 3;`;
    const hospQ   = `[out:json][timeout:10];node["amenity"="hospital"](around:5000,${lat},${lng});out 3;`;

    Promise.all([
        fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(policeQ)}`).then(r=>r.json()).catch(()=>({elements:[]})),
        fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(hospQ)}`).then(r=>r.json()).catch(()=>({elements:[]}))
    ]).then(([police, hosp]) => {
        const lang = localStorage.getItem('resqnet_lang') || 'en';
        const t = (translations[lang] || translations.en);
        let html = '';
        if (police.elements?.length) {
            html += `<h3 style="color:#e91e8c;margin-bottom:8px;">👮 ${t.ws_nearby_police||'Nearby Police Stations'}</h3>`;
            police.elements.slice(0,3).forEach(p => {
                const d = wsDist(lat, lng, p.lat, p.lon).toFixed(1);
                html += `<div class="ws-service-card">🚔 ${p.tags?.name||'Police Station'} — ${d} km</div>`;
            });
        }
        if (hosp.elements?.length) {
            html += `<h3 style="color:#e91e8c;margin:12px 0 8px;">🏥 ${t.ws_nearby_hosp||'Nearby Hospitals'}</h3>`;
            hosp.elements.slice(0,3).forEach(h => {
                const d = wsDist(lat, lng, h.lat, h.lon).toFixed(1);
                html += `<div class="ws-service-card">🏥 ${h.tags?.name||'Hospital'} — ${d} km</div>`;
            });
        }
        if (!html) html = '<p style="color:#555;">Fetching nearby services...</p>';
        servicesList.innerHTML = html;
    });
}

// ── Banner helper ─────────────────────────────────────────────
function wsShowBanner(type, msg) {
    const banner = document.getElementById('ws-status-banner');
    if (!banner) return;
    banner.className = `ws-banner ${type}`;
    banner.textContent = msg;
}

// Init Women's Safety page on load
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('ws-main')) {
        wsRenderPage();
        wsInitMap();
        const resumedJourney = wsGetJourney();
        if (resumedJourney) {
            wsJourneyActive = true;
            // Restore in-memory path from localStorage
            if (resumedJourney.path) {
                wsJourneyPath = resumedJourney.path.map(p => [p[0], p[1]]);
            }
            wsStartGPS();
            wsStartShake();
            wsStartVoiceSOS_WS();
        }
    }
});

// ═══════════════════════════════════════════════════════════
// WOMEN'S SAFETY — LIVE MAP
// ═══════════════════════════════════════════════════════════

let wsMap            = null;
let wsUserMarker     = null;
let wsRouteLine      = null;
let wsMapMarkers     = [];

function wsInitMap() {
    const mapEl = document.getElementById('ws-live-map');
    if (!mapEl || typeof L === 'undefined') return;
    if (wsMap) { wsMap.remove(); wsMap = null; }

    wsMap = L.map('ws-live-map', { zoomControl: true }).setView([20.5937, 78.9629], 5);

    // Dark-tinted tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        className: 'ws-map-tiles'
    }).addTo(wsMap);

    // Try to get user location immediately
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            const { latitude: lat, longitude: lng } = pos.coords;
            wsMap.setView([lat, lng], 14);
            wsPlaceUserMarker(lat, lng);
            wsLastLat = lat; wsLastLng = lng;
            wsMapLoadServices(lat, lng);
        }, () => {}, { enableHighAccuracy: true });
    }
}

function wsPlaceUserMarker(lat, lng) {
    if (!wsMap) return;
    const icon = L.divIcon({
        className: '',
        html: '<div style="background:#e91e8c;width:16px;height:16px;border-radius:50%;border:3px solid white;box-shadow:0 0 10px #e91e8c;"></div>',
        iconSize: [16, 16], iconAnchor: [8, 8]
    });
    if (wsUserMarker) wsUserMarker.setLatLng([lat, lng]);
    else wsUserMarker = L.marker([lat, lng], { icon }).addTo(wsMap).bindPopup('📍 Your Location');
}

function wsDrawRoutePath() {
    if (!wsMap) return;

    // Use in-memory path for performance; fall back to localStorage
    let coords = wsJourneyPath.length > 0
        ? wsJourneyPath
        : (wsGetJourney()?.path || []).map(p => [p[0], p[1]]);

    if (coords.length === 0) return;

    if (wsRouteLine) wsMap.removeLayer(wsRouteLine);

    if (coords.length === 1) {
        // Single point — draw a small circle to show journey start
        wsRouteLine = L.circleMarker(coords[0], {
            radius: 6, color: '#e91e8c', fillColor: '#e91e8c',
            fillOpacity: 0.5, weight: 2
        }).addTo(wsMap).bindPopup('🚀 Journey Start');
    } else {
        wsRouteLine = L.polyline(coords, {
            color: '#e91e8c', weight: 4, opacity: 0.85, dashArray: '8 4'
        }).addTo(wsMap);
        // Pan map to follow latest position
        wsMap.panTo(coords[coords.length - 1], { animate: true });
    }
}

function wsMapLoadServices(lat, lng) {
    if (!wsMap) return;
    // Remove old service markers
    wsMapMarkers.forEach(m => wsMap.removeLayer(m));
    wsMapMarkers = [];

    const policeQ = `[out:json][timeout:10];node["amenity"="police"](around:5000,${lat},${lng});out 5;`;
    const hospQ   = `[out:json][timeout:10];node["amenity"="hospital"](around:5000,${lat},${lng});out 5;`;

    fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(policeQ)}`)
        .then(r => r.json()).then(data => {
            (data.elements || []).slice(0, 4).forEach(p => {
                const icon = L.divIcon({ className:'', html:'<div style="font-size:20px;line-height:1;">🚔</div>', iconSize:[24,24], iconAnchor:[12,12] });
                const m = L.marker([p.lat, p.lon], { icon }).addTo(wsMap)
                    .bindPopup(`<b>🚔 ${p.tags?.name || 'Police Station'}</b><br>${wsDist(lat,lng,p.lat,p.lon).toFixed(1)} km away`);
                wsMapMarkers.push(m);
            });
        }).catch(() => {});

    fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(hospQ)}`)
        .then(r => r.json()).then(data => {
            (data.elements || []).slice(0, 4).forEach(h => {
                const icon = L.divIcon({ className:'', html:'<div style="font-size:20px;line-height:1;">🏥</div>', iconSize:[24,24], iconAnchor:[12,12] });
                const m = L.marker([h.lat, h.lon], { icon }).addTo(wsMap)
                    .bindPopup(`<b>🏥 ${h.tags?.name || 'Hospital'}</b><br>${wsDist(lat,lng,h.lat,h.lon).toFixed(1)} km away`);
                wsMapMarkers.push(m);
            });
        }).catch(() => {});
}

function wsMapRefresh() {
    if (!navigator.geolocation || !wsMap) return;
    navigator.geolocation.getCurrentPosition(pos => {
        const { latitude: lat, longitude: lng } = pos.coords;
        wsPlaceUserMarker(lat, lng);
        wsMap.panTo([lat, lng]);
        wsMapLoadServices(lat, lng);
        wsDrawRoutePath();
    }, () => alert('Location unavailable'), { enableHighAccuracy: true });
}