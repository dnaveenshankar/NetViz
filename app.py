from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import random
import re
import secrets
import socket
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from starlette.templating import Jinja2Templates

from quiz_bank import MODULES, QUESTION_BANK

BASE_DIR = Path(__file__).resolve().parent
SERVERLESS = os.environ.get("NETVIZ_SERVERLESS") == "1" or bool(os.environ.get("VERCEL"))
DEFAULT_DATABASE = Path("/tmp/netviz.db") if SERVERLESS else BASE_DIR / "netviz.db"
DATABASE = Path(os.environ.get("NETVIZ_DATABASE", DEFAULT_DATABASE))
SESSION_SECRET_CONFIGURED = bool(os.environ.get("NETVIZ_SECRET_KEY"))
HTTPS_ONLY_SETTING = os.environ.get("NETVIZ_HTTPS_ONLY")
SESSION_HTTPS_ONLY = SERVERLESS if HTTPS_ONLY_SETTING is None else HTTPS_ONLY_SETTING == "1"

app = FastAPI(title="NetViz Advanced Network Engineering Lab", version="3.0.0")
app.add_middleware(
    SessionMiddleware,
    secret_key=os.environ.get("NETVIZ_SECRET_KEY", secrets.token_hex(32)),
    same_site="lax",
    https_only=SESSION_HTTPS_ONLY,
)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def db() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db() -> None:
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    with db() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS topologies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS quiz_scores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                module TEXT NOT NULL DEFAULT 'fundamentals',
                difficulty TEXT NOT NULL,
                score INTEGER NOT NULL,
                total INTEGER NOT NULL,
                weak_topics TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS simulation_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                simulation_type TEXT NOT NULL,
                summary TEXT NOT NULL,
                details TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS dhcp_leases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                client_id TEXT NOT NULL,
                ip_address TEXT NOT NULL,
                network TEXT NOT NULL,
                lease_seconds INTEGER NOT NULL,
                assigned_at TEXT NOT NULL,
                UNIQUE(user_id, client_id, network)
            );
            """
        )
        columns = {row[1] for row in connection.execute("PRAGMA table_info(quiz_scores)")}
        if "module" not in columns:
            connection.execute("ALTER TABLE quiz_scores ADD COLUMN module TEXT NOT NULL DEFAULT 'fundamentals'")


init_db()


def require_user(request: Request) -> int:
    user_id = ensure_session_user(request)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user_id


def ensure_session_user(request: Request) -> int | None:
    """Resolve the signed session to a user in the active SQLite instance.

    Vercel's ``/tmp`` filesystem is isolated and ephemeral. A warm instance can
    retain its local database, but a later request may reach a fresh instance.
    Rehydrating the signed session identity prevents authenticated demo actions
    from failing with foreign-key errors after a cold start. Durable saved data
    still requires a persistent database outside Vercel's filesystem.
    """
    username = request.session.get("username")
    if not username:
        return None
    with db() as connection:
        user = connection.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
        if user:
            user_id = int(user["id"])
        elif SERVERLESS:
            cursor = connection.execute(
                "INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)",
                (username, hash_password(secrets.token_urlsafe(24)), now_iso()),
            )
            user_id = int(cursor.lastrowid)
        else:
            return None
    request.session["user_id"] = user_id
    return user_id


async def body(request: Request) -> dict:
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, ValueError):
        return {}


def error(message: str, status: int) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def valid_username(value: str) -> bool:
    return 3 <= len(value) <= 32 and all(c.isalnum() or c in "_-" for c in value)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, salt_hex, digest_hex = stored.split("$", 2)
        if algorithm != "scrypt":
            return False
        candidate = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1)
        return hmac.compare_digest(candidate.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/api/health")
async def health():
    return {
        "status": "ok", "service": "NetViz", "version": app.version,
        "time": now_iso(), "runtime": "vercel-serverless" if SERVERLESS else "local",
    }


@app.get("/api/deployment")
async def deployment_info():
    return {
        "platform": "vercel" if SERVERLESS else "local",
        "serverless": SERVERLESS,
        "database_path": str(DATABASE),
        "persistence": "ephemeral" if SERVERLESS else "persistent-local",
        "session_secret_configured": SESSION_SECRET_CONFIGURED,
        "message": (
            "Vercel uses isolated ephemeral /tmp storage. Simulations work, but accounts, saved topologies, "
            "leases, scores, and challenge records are not guaranteed to persist across cold starts."
            if SERVERLESS else "SQLite data persists at the configured local path."
        ),
    }


@app.post("/api/register")
async def register(request: Request):
    data = await body(request)
    username, password = str(data.get("username", "")).strip(), str(data.get("password", ""))
    if not valid_username(username):
        return error("Username must be 3–32 letters, numbers, underscores, or hyphens.", 400)
    if len(password) < 8:
        return error("Password must contain at least 8 characters.", 400)
    try:
        with db() as connection:
            cursor = connection.execute(
                "INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)",
                (username, hash_password(password), now_iso()),
            )
            user_id = cursor.lastrowid
    except sqlite3.IntegrityError:
        return error("That username already exists.", 409)
    request.session.clear()
    request.session.update({"user_id": user_id, "username": username})
    return JSONResponse({"user": {"id": user_id, "username": username}}, status_code=201)


@app.post("/api/login")
async def login(request: Request):
    data = await body(request)
    username, password = str(data.get("username", "")).strip(), str(data.get("password", ""))
    with db() as connection:
        user = connection.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if not user or not verify_password(password, user["password_hash"]):
        return error("Invalid username or password.", 401)
    request.session.clear()
    request.session.update({"user_id": user["id"], "username": user["username"]})
    return {"user": {"id": user["id"], "username": user["username"]}}


@app.post("/api/guest")
async def guest_login(request: Request):
    """Create an isolated local guest profile so every simulator remains writable."""
    suffix = secrets.token_hex(3)
    username = f"Guest-{suffix.upper()}"
    with db() as connection:
        cursor = connection.execute(
            "INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)",
            (username, hash_password(secrets.token_urlsafe(24)), now_iso()),
        )
        user_id = cursor.lastrowid
    request.session.clear()
    request.session.update({"user_id": user_id, "username": username, "guest": True})
    return JSONResponse({"user": {"id": user_id, "username": username, "guest": True}}, status_code=201)


@app.post("/api/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/api/me")
async def me(request: Request):
    user_id = ensure_session_user(request)
    if user_id is None:
        return {"user": None}
    return {"user": {"id": user_id, "username": request.session["username"], "guest": bool(request.session.get("guest"))}}


@app.get("/api/topologies")
async def list_topologies(request: Request):
    user_id = require_user(request)
    with db() as connection:
        rows = connection.execute(
            "SELECT id,name,created_at,updated_at FROM topologies WHERE user_id=? ORDER BY updated_at DESC", (user_id,)
        ).fetchall()
    return {"topologies": [dict(row) for row in rows]}


@app.post("/api/topologies")
async def create_topology(request: Request):
    user_id, data = require_user(request), await body(request)
    name = str(data.get("name", "Untitled topology")).strip()[:80] or "Untitled topology"
    topology = data.get("data")
    if not isinstance(topology, dict):
        return error("Topology data must be an object.", 400)
    timestamp = now_iso()
    with db() as connection:
        cursor = connection.execute(
            "INSERT INTO topologies(user_id,name,data,created_at,updated_at) VALUES(?,?,?,?,?)",
            (user_id, name, json.dumps(topology), timestamp, timestamp),
        )
    return JSONResponse({"id": cursor.lastrowid, "name": name, "updated_at": timestamp}, status_code=201)


def owned_topology(topology_id: int, user_id: int):
    with db() as connection:
        return connection.execute("SELECT * FROM topologies WHERE id=? AND user_id=?", (topology_id, user_id)).fetchone()


@app.get("/api/topologies/{topology_id}")
async def get_topology(topology_id: int, request: Request):
    row = owned_topology(topology_id, require_user(request))
    if not row:
        return error("Topology not found.", 404)
    return {"id": row["id"], "name": row["name"], "data": json.loads(row["data"]), "updated_at": row["updated_at"]}


@app.put("/api/topologies/{topology_id}")
async def update_topology(topology_id: int, request: Request):
    user_id, data = require_user(request), await body(request)
    row = owned_topology(topology_id, user_id)
    if not row:
        return error("Topology not found.", 404)
    name = str(data.get("name", row["name"])).strip()[:80] or row["name"]
    topology = data.get("data", json.loads(row["data"]))
    if not isinstance(topology, dict):
        return error("Topology data must be an object.", 400)
    timestamp = now_iso()
    with db() as connection:
        connection.execute("UPDATE topologies SET name=?,data=?,updated_at=? WHERE id=?", (name, json.dumps(topology), timestamp, topology_id))
    return {"id": topology_id, "name": name, "updated_at": timestamp}


@app.delete("/api/topologies/{topology_id}")
async def delete_topology(topology_id: int, request: Request):
    user_id = require_user(request)
    if not owned_topology(topology_id, user_id):
        return error("Topology not found.", 404)
    with db() as connection:
        connection.execute("DELETE FROM topologies WHERE id=?", (topology_id,))
    return {"ok": True}


@app.post("/api/dns")
async def dns_lookup(request: Request):
    data = await body(request)
    query, record_type = str(data.get("query", "")).strip(), str(data.get("type", "A")).upper()
    if not query or len(query) > 255 or record_type not in {"A", "AAAA", "PTR"}:
        return error("Provide a valid query and A, AAAA, or PTR type.", 400)
    if record_type != "PTR" and "://" in query:
        query = urlparse(query).hostname or ""
    query = query.rstrip(".").lower()
    if record_type == "PTR":
        try:
            ipaddress.ip_address(query)
        except ValueError:
            return error("PTR lookup requires a valid IPv4 or IPv6 address.", 400)
    elif not re.fullmatch(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", query):
        return error("Enter a valid hostname or URL, for example https://www.example.com/path.", 400)
    try:
        if record_type == "PTR":
            hostname, aliases, addresses = socket.gethostbyaddr(query)
            return {"query": query, "type": "PTR", "answers": [hostname, *aliases], "addresses": addresses, "resolver": "System configured resolver"}
        family = socket.AF_INET if record_type == "A" else socket.AF_INET6
        results = socket.getaddrinfo(query, None, family, socket.SOCK_STREAM)
        return {"query": query, "type": record_type, "answers": sorted({item[4][0] for item in results}), "resolver": "System configured resolver"}
    except (socket.gaierror, socket.herror, ValueError) as exc:
        return error(f"DNS lookup failed: {exc}", 404)


@app.post("/api/subnet")
async def subnet_calculator(request: Request):
    value = str((await body(request)).get("network", "")).strip()
    try:
        interface = ipaddress.ip_interface(value)
        if interface.version != 4:
            raise ValueError("Only IPv4 is supported in this lab")
        network = interface.network
        first = network.network_address + 1 if network.num_addresses > 2 else network.network_address
        last = network.broadcast_address - 1 if network.num_addresses > 2 else network.broadcast_address
        usable = max(network.num_addresses - 2, 0) if network.prefixlen < 31 else network.num_addresses
        first_octet = int(str(interface.ip).split(".")[0])
        ip_class = "A" if first_octet < 128 else "B" if first_octet < 192 else "C" if first_octet < 224 else "D/E"
        scope = "Private" if interface.ip.is_private else "Public" if interface.ip.is_global else "Special-use"
        return {
            "input": str(interface), "network": str(network.network_address), "broadcast": str(network.broadcast_address),
            "netmask": str(network.netmask), "wildcard": str(network.hostmask), "prefix": network.prefixlen,
            "total": network.num_addresses, "usable": usable, "first_host": str(first), "last_host": str(last),
            "suggested_gateway": str(first), "historical_class": ip_class, "scope": scope,
            "binary_mask": ".".join(f"{int(o):08b}" for o in str(network.netmask).split(".")),
        }
    except ValueError as exc:
        return error(f"Invalid IPv4 interface: {exc}. Try 192.168.1.10/24.", 400)


@app.get("/api/dhcp/leases")
async def list_leases(request: Request):
    user_id = require_user(request)
    with db() as connection:
        rows = connection.execute(
            "SELECT id,client_id,ip_address,network,lease_seconds,assigned_at FROM dhcp_leases WHERE user_id=? ORDER BY assigned_at DESC", (user_id,)
        ).fetchall()
    leases = []
    now = datetime.now(timezone.utc)
    for row in rows:
        item = dict(row)
        assigned = datetime.fromisoformat(item["assigned_at"])
        duration = item["lease_seconds"]
        item.update({
            "t1_at": (assigned + timedelta(seconds=duration * .5)).isoformat(timespec="seconds"),
            "t2_at": (assigned + timedelta(seconds=duration * .875)).isoformat(timespec="seconds"),
            "expires_at": (assigned + timedelta(seconds=duration)).isoformat(timespec="seconds"),
            "remaining_seconds": max(0, int((assigned + timedelta(seconds=duration) - now).total_seconds())),
        })
        leases.append(item)
    return {"leases": leases}


@app.post("/api/dhcp/leases")
async def create_lease(request: Request):
    user_id, data = require_user(request), await body(request)
    client_id = str(data.get("client_id", "client-01")).strip()[:64]
    network_text = str(data.get("network", "192.168.10.0/24")).strip()
    try:
        lease_seconds = max(60, min(int(data.get("lease_seconds", 3600)), 604800))
        network = ipaddress.ip_network(network_text, strict=False)
        if network.version != 4 or network.prefixlen > 29:
            raise ValueError("Use an IPv4 pool with at least six usable addresses.")
    except (ValueError, TypeError) as exc:
        return error(str(exc), 400)
    with db() as connection:
        existing = connection.execute(
            "SELECT id,ip_address,lease_seconds,assigned_at FROM dhcp_leases WHERE user_id=? AND network=?", (user_id, str(network))
        ).fetchall()
        now = datetime.now(timezone.utc)
        expired_ids = [r["id"] for r in existing if datetime.fromisoformat(r["assigned_at"]) + timedelta(seconds=r["lease_seconds"]) <= now]
        if expired_ids:
            connection.executemany("DELETE FROM dhcp_leases WHERE id=?", [(value,) for value in expired_ids])
        used = {r["ip_address"] for r in existing if r["id"] not in expired_ids}
        host_iter = network.hosts()
        next(host_iter, None)  # reserve the first usable address as gateway/server
        selected = next((str(ip) for ip in host_iter if str(ip) not in used), None)
        if not selected:
            return error("The simulated DHCP pool is exhausted.", 409)
        assigned = now_iso()
        connection.execute(
            "INSERT INTO dhcp_leases(user_id,client_id,ip_address,network,lease_seconds,assigned_at) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(user_id,client_id,network) DO UPDATE SET ip_address=excluded.ip_address,lease_seconds=excluded.lease_seconds,assigned_at=excluded.assigned_at",
            (user_id, client_id, selected, str(network), lease_seconds, assigned),
        )
    assigned_dt = datetime.fromisoformat(assigned)
    return JSONResponse({
        "client_id": client_id, "ip_address": selected, "network": str(network), "lease_seconds": lease_seconds,
        "assigned_at": assigned, "t1_at": (assigned_dt + timedelta(seconds=lease_seconds * .5)).isoformat(timespec="seconds"),
        "t2_at": (assigned_dt + timedelta(seconds=lease_seconds * .875)).isoformat(timespec="seconds"),
        "expires_at": (assigned_dt + timedelta(seconds=lease_seconds)).isoformat(timespec="seconds"),
    }, status_code=201)


@app.delete("/api/dhcp/leases/{lease_id}")
async def release_lease(lease_id: int, request: Request):
    user_id = require_user(request)
    with db() as connection:
        cursor = connection.execute("DELETE FROM dhcp_leases WHERE id=? AND user_id=?", (lease_id, user_id))
    if cursor.rowcount == 0:
        return error("Lease not found.", 404)
    return {"ok": True, "state": "released"}


QUIZZES = {
    "beginner": [
        {"q": "Which device forwards frames using a MAC address table?", "options": ["Switch", "Router", "DNS server", "Modem"], "answer": 0, "topic": "Switching", "explanation": "A Layer 2 switch learns source MAC addresses and forwards frames by destination MAC."},
        {"q": "What does DNS primarily translate?", "options": ["Ports to processes", "Names to IP addresses", "MAC to VLAN", "Frames to bits"], "answer": 1, "topic": "DNS", "explanation": "DNS maps human-readable names to records such as IPv4 A and IPv6 AAAA addresses."},
        {"q": "Which DHCP message starts DORA?", "options": ["Offer", "Request", "Discover", "ACK"], "answer": 2, "topic": "DHCP", "explanation": "A client broadcasts DHCPDISCOVER before the server offers an address."},
        {"q": "Which protocol is connection-oriented?", "options": ["UDP", "ARP", "TCP", "ICMP"], "answer": 2, "topic": "Transport", "explanation": "TCP establishes a connection and provides ordered, acknowledged delivery."},
    ],
    "intermediate": [
        {"q": "An access port normally carries traffic for how many VLANs?", "options": ["One", "Two", "All", "None"], "answer": 0, "topic": "VLANs", "explanation": "An access port assigns untagged endpoint traffic to one access VLAN."},
        {"q": "Which route wins for 10.1.2.7?", "options": ["0.0.0.0/0", "10.0.0.0/8", "10.1.0.0/16", "10.1.2.0/24"], "answer": 3, "topic": "Routing", "explanation": "Longest-prefix matching selects the most specific /24 route."},
        {"q": "What field does a router rewrite at each Ethernet hop?", "options": ["Source IP", "Destination IP", "Layer 2 MAC addresses", "TCP port"], "answer": 2, "topic": "Routing", "explanation": "The IP packet remains end-to-end, while each routed hop uses a new Layer 2 frame."},
        {"q": "What is the broadcast of 192.168.5.0/24?", "options": ["192.168.5.0", "192.168.5.1", "192.168.5.254", "192.168.5.255"], "answer": 3, "topic": "Subnetting", "explanation": "A /24 leaves eight host bits, all ones in the broadcast address."},
    ],
    "advanced": [
        {"q": "Why does STP block a redundant Layer 2 path?", "options": ["To encrypt frames", "To prevent bridging loops", "To add VLAN tags", "To allocate IPs"], "answer": 1, "topic": "STP", "explanation": "STP creates a loop-free logical tree while retaining redundancy for failure recovery."},
        {"q": "Which extended ACL is evaluated first?", "options": ["The most specific prefix", "The last configured", "The first matching rule", "Permit always precedes deny"], "answer": 2, "topic": "Security", "explanation": "ACL entries are processed top-down and stop at the first match, followed by implicit deny."},
        {"q": "A trunk receives an untagged frame. Which VLAN is normally assigned?", "options": ["Allowed list first VLAN", "Native VLAN", "VLAN 4095", "No VLAN"], "answer": 1, "topic": "VLANs", "explanation": "On an 802.1Q trunk, untagged traffic is associated with the native VLAN."},
        {"q": "TCP receives ACK 5001 after sending SEQ 4001 with 1000 bytes. What does it mean?", "options": ["Resend byte 5001", "Bytes through 5000 arrived", "Connection closed", "Window is zero"], "answer": 1, "topic": "Transport", "explanation": "TCP ACK is cumulative and identifies the next byte expected."},
    ],
}

DIFFICULTY_ORDER = {"beginner": 0, "intermediate": 1, "advanced": 2}


@app.get("/api/quiz-modules")
async def quiz_modules():
    return {
        "modules": [
            {"id": key, **metadata, "question_count": len(QUESTION_BANK[key]) // 3, "question_variants": len(QUESTION_BANK[key]), "max_session_questions": 20}
            for key, metadata in MODULES.items()
        ],
        "difficulties": list(DIFFICULTY_ORDER),
    }


@app.get("/api/quiz-session/{module}/{difficulty}")
async def start_quiz_session(module: str, difficulty: str, request: Request, limit: int = 10):
    if module not in QUESTION_BANK or difficulty not in DIFFICULTY_ORDER:
        return error("Choose a valid quiz module and difficulty.", 404)
    limit = max(1, min(limit, 20))
    pool = [q for q in QUESTION_BANK[module] if q["difficulty"] == difficulty]
    seen_map = request.session.get("quiz_seen", {})
    key = f"{module}:{difficulty}"
    seen = set(seen_map.get(key, []))
    available = [q for q in pool if q["id"] not in seen]
    cycle_reset = False
    if not available:
        seen.clear()
        available = list(pool)
        cycle_reset = True
    random.SystemRandom().shuffle(available)
    selected = available[:limit]
    seen.update(q["id"] for q in selected)
    seen_map[key] = sorted(seen)
    request.session["quiz_seen"] = seen_map
    public = []
    for question in selected:
        options = list(question["options"])
        random.SystemRandom().shuffle(options)
        public.append({
            "id": question["id"], "q": question["q"], "options": options,
            "topic": question["topic"], "difficulty": question["difficulty"],
        })
    return {
        "module": {"id": module, **MODULES[module]}, "difficulty": difficulty, "questions": public,
        "served": len(public), "remaining_before_reset": max(0, len(pool) - len(seen)), "cycle_reset": cycle_reset,
    }


@app.post("/api/quiz-session/{module}/{difficulty}/submit")
async def submit_quiz_session(module: str, difficulty: str, request: Request):
    user_id = require_user(request)
    if module not in QUESTION_BANK or difficulty not in DIFFICULTY_ORDER:
        return error("Unknown quiz module or difficulty.", 404)
    data = await body(request)
    answers = data.get("answers", {})
    if not isinstance(answers, dict) or not answers:
        return error("Submit at least one answer.", 400)
    lookup = {q["id"]: q for q in QUESTION_BANK[module]}
    results, weak, score = [], [], 0
    for question_id, chosen in answers.items():
        question = lookup.get(question_id)
        if not question:
            continue
        correct = str(chosen) == question["correct"]
        score += int(correct)
        if not correct:
            weak.append(question["explanation"].split(":", 1)[0])
        results.append({
            "id": question_id, "correct": correct, "chosen": chosen, "correct_answer": question["correct"],
            "explanation": question["explanation"], "difficulty": question["difficulty"],
        })
    if not results:
        return error("No recognized question IDs were submitted.", 400)
    timestamp = now_iso()
    with db() as connection:
        connection.execute(
            "INSERT INTO quiz_scores(user_id,module,difficulty,score,total,weak_topics,created_at) VALUES(?,?,?,?,?,?,?)",
            (user_id, module, difficulty, score, len(results), json.dumps(sorted(set(weak))), timestamp),
        )
    return {
        "score": score, "total": len(results), "percentage": round(score / len(results) * 100),
        "results": results, "revision_topics": sorted(set(weak)), "module": MODULES[module]["title"],
    }


@app.get("/api/quiz/{difficulty}")
async def quiz(difficulty: str):
    questions = QUIZZES.get(difficulty)
    if not questions:
        return error("Choose beginner, intermediate, or advanced.", 404)
    return {"difficulty": difficulty, "questions": [{"id": i, "q": q["q"], "options": q["options"], "topic": q["topic"]} for i, q in enumerate(questions)]}


@app.post("/api/quiz/{difficulty}/submit")
async def submit_quiz(difficulty: str, request: Request):
    user_id, questions = require_user(request), QUIZZES.get(difficulty)
    if not questions:
        return error("Unknown difficulty.", 404)
    answers = (await body(request)).get("answers", [])
    results, score, weak = [], 0, []
    for index, question in enumerate(questions):
        chosen = answers[index] if index < len(answers) else None
        correct = chosen == question["answer"]
        score += int(correct)
        if not correct:
            weak.append(question["topic"])
        results.append({"id": index, "correct": correct, "answer": question["answer"], "explanation": question["explanation"], "topic": question["topic"]})
    with db() as connection:
        connection.execute(
            "INSERT INTO quiz_scores(user_id,difficulty,score,total,weak_topics,created_at) VALUES(?,?,?,?,?,?)",
            (user_id, difficulty, score, len(questions), json.dumps(sorted(set(weak))), now_iso()),
        )
    return {"score": score, "total": len(questions), "results": results, "revision_topics": sorted(set(weak))}


@app.get("/api/quiz-history")
async def quiz_history(request: Request):
    user_id = require_user(request)
    with db() as connection:
        rows = connection.execute(
            "SELECT difficulty,score,total,weak_topics,created_at FROM quiz_scores WHERE user_id=? ORDER BY created_at DESC LIMIT 50", (user_id,)
        ).fetchall()
    history, best = [], {}
    for row in rows:
        item = dict(row)
        item["weak_topics"] = json.loads(item["weak_topics"])
        history.append(item)
        best[row["difficulty"]] = max(best.get(row["difficulty"], 0), row["score"])
    return {"history": history, "best": best}


@app.get("/api/history")
async def list_history(request: Request):
    user_id = require_user(request)
    with db() as connection:
        rows = connection.execute(
            "SELECT id,simulation_type,summary,details,created_at FROM simulation_history WHERE user_id=? ORDER BY created_at DESC LIMIT 100", (user_id,)
        ).fetchall()
    return {"history": [{**dict(r), "details": json.loads(r["details"])} for r in rows]}


@app.post("/api/history")
async def create_history(request: Request):
    user_id, data = require_user(request), await body(request)
    simulation_type = str(data.get("type", "lab"))[:40]
    summary = str(data.get("summary", "Simulation completed"))[:240]
    details = data.get("details", {})
    with db() as connection:
        cursor = connection.execute(
            "INSERT INTO simulation_history(user_id,simulation_type,summary,details,created_at) VALUES(?,?,?,?,?)",
            (user_id, simulation_type, summary, json.dumps(details), now_iso()),
        )
    return JSONResponse({"id": cursor.lastrowid}, status_code=201)


@app.get("/api/analytics")
async def analytics(request: Request):
    user_id = require_user(request)
    with db() as connection:
        user = connection.execute("SELECT username,created_at FROM users WHERE id=?", (user_id,)).fetchone()
        quiz = connection.execute(
            "SELECT module,difficulty,SUM(score) correct,SUM(total) total,COUNT(*) attempts,MAX(score * 100.0 / total) best FROM quiz_scores WHERE user_id=? GROUP BY module,difficulty",
            (user_id,),
        ).fetchall()
        simulation_rows = connection.execute(
            "SELECT simulation_type,COUNT(*) count FROM simulation_history WHERE user_id=? GROUP BY simulation_type", (user_id,)
        ).fetchall()
        totals = connection.execute(
            "SELECT COALESCE(SUM(score),0) correct,COALESCE(SUM(total),0) total,COUNT(*) attempts FROM quiz_scores WHERE user_id=?", (user_id,)
        ).fetchone()
        simulation_total = connection.execute("SELECT COUNT(*) FROM simulation_history WHERE user_id=?", (user_id,)).fetchone()[0]
        leaders = connection.execute(
            """
            SELECT u.username,
                   COALESCE(SUM(q.score),0) correct,
                   COALESCE(SUM(q.total),0) total,
                   COUNT(q.id) attempts,
                   COALESCE((SELECT COUNT(*) FROM simulation_history s WHERE s.user_id=u.id),0) simulations
            FROM users u LEFT JOIN quiz_scores q ON q.user_id=u.id
            GROUP BY u.id ORDER BY (COALESCE(SUM(q.score),0)*20 + COALESCE((SELECT COUNT(*) FROM simulation_history s WHERE s.user_id=u.id),0)*10) DESC,
                     CASE WHEN COALESCE(SUM(q.total),0)=0 THEN 0 ELSE SUM(q.score)*1.0/SUM(q.total) END DESC
            LIMIT 20
            """
        ).fetchall()
    correct, total = totals["correct"], totals["total"]
    xp = correct * 20 + simulation_total * 10
    level = 1 + xp // 500
    return {
        "profile": {"username": user["username"], "joined": user["created_at"], "xp": xp, "level": level, "next_level_xp": level * 500},
        "summary": {"quiz_attempts": totals["attempts"], "correct": correct, "questions": total, "accuracy": round(correct / total * 100) if total else 0, "simulations": simulation_total},
        "mastery": [{**dict(row), "title": MODULES.get(row["module"], {"title": row["module"]})["title"]} for row in quiz],
        "simulation_mix": [dict(row) for row in simulation_rows],
        "leaderboard": [
            {"rank": index + 1, **dict(row), "accuracy": round(row["correct"] / row["total"] * 100) if row["total"] else 0, "xp": row["correct"] * 20 + row["simulations"] * 10}
            for index, row in enumerate(leaders)
        ],
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=os.environ.get("NETVIZ_HOST", "127.0.0.1"), port=int(os.environ.get("NETVIZ_PORT", "5000")), reload=os.environ.get("NETVIZ_DEBUG") == "1")
