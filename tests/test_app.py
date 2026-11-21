import importlib
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


@pytest.fixture()
def client(tmp_path):
    os.environ["NETVIZ_DATABASE"] = str(tmp_path / "test.db")
    os.environ["NETVIZ_SECRET_KEY"] = "test-secret"
    if "app" in sys.modules:
        del sys.modules["app"]
    module = importlib.import_module("app")
    module.init_db()
    with TestClient(module.app) as test_client:
        yield test_client


def register(client):
    response = client.post("/api/register", json={"username": "student01", "password": "networklab"})
    assert response.status_code == 201


def test_health_and_home(client):
    assert client.get("/api/health").status_code == 200
    home = client.get("/")
    assert home.status_code == 200
    assert b"Advanced Network Engineering Lab" in home.content
    assert b'id="blankTopology"' in home.content
    assert b'id="missions"' in home.content
    assert b'id="mediaSections"' in home.content
    assert b'id="receiverDecap"' in home.content


def test_registration_topology_and_history(client):
    register(client)
    saved = client.post("/api/topologies", json={"name": "Lab 1", "data": {"nodes": [], "links": []}})
    assert saved.status_code == 201
    topology_id = saved.json()["id"]
    loaded = client.get(f"/api/topologies/{topology_id}")
    assert loaded.json()["name"] == "Lab 1"
    history = client.post("/api/history", json={"type": "packet", "summary": "Delivered", "details": {"hops": 3}})
    assert history.status_code == 201
    assert len(client.get("/api/history").json()["history"]) == 1


def test_subnet_calculator(client):
    data = client.post("/api/subnet", json={"network": "192.168.10.42/24"}).json()
    assert data["network"] == "192.168.10.0"
    assert data["broadcast"] == "192.168.10.255"
    assert data["usable"] == 254
    assert data["scope"] == "Private"


def test_dns_validation(client):
    assert client.post("/api/dns", json={"query": "", "type": "A"}).status_code == 400
    assert client.post("/api/dns", json={"query": "1.2.3.4", "type": "MX"}).status_code == 400
    assert client.post("/api/dns", json={"query": "bad host name", "type": "A"}).status_code == 400
    local = client.post("/api/dns", json={"query": "http://localhost/networking", "type": "A"})
    assert local.status_code == 200
    assert "127.0.0.1" in local.json()["answers"]


def test_dhcp_and_quiz(client):
    register(client)
    lease = client.post("/api/dhcp/leases", json={"client_id": "laptop", "network": "10.10.10.0/24", "lease_seconds": 3600})
    assert lease.status_code == 201
    assert lease.json()["ip_address"] == "10.10.10.2"
    assert {"t1_at", "t2_at", "expires_at"} <= lease.json().keys()
    questions = client.get("/api/quiz/beginner").json()["questions"]
    assert len(questions) == 4
    result = client.post("/api/quiz/beginner/submit", json={"answers": [0, 1, 2, 2]}).json()
    assert result["score"] == 4
    assert client.get("/api/quiz-history").json()["best"]["beginner"] == 4


def test_guest_quiz_academy_and_analytics(client):
    guest = client.post("/api/guest")
    assert guest.status_code == 201
    assert guest.json()["user"]["guest"] is True
    modules = client.get("/api/quiz-modules").json()["modules"]
    assert len(modules) == 9
    assert all(module["question_count"] == 20 for module in modules)
    first = client.get("/api/quiz-session/switching/advanced?limit=20").json()
    assert len(first["questions"]) == 20
    assert len({question["id"] for question in first["questions"]}) == 20
    question = first["questions"][0]
    submitted = client.post(
        "/api/quiz-session/switching/advanced/submit",
        json={"answers": {question["id"]: question["options"][0]}},
    )
    assert submitted.status_code == 200
    assert submitted.json()["results"][0]["explanation"]
    analytics = client.get("/api/analytics")
    assert analytics.status_code == 200
    assert analytics.json()["summary"]["quiz_attempts"] == 1
