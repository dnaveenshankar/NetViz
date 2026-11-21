# NetViz 3.0 — Advanced Network Engineering Lab

NetViz is a browser-based educational network simulator built with Python, FastAPI, SQLite, SVG, CSS, and JavaScript. Version 3 introduces a colorful light interface, deterministic animation state machines, visible receiver-side decapsulation, five reliable media studios, topic cards with embedded quiz levels, and a scenario-based Network Challenge Lab.

> **Educational boundary:** switching, routing, ACLs, DHCP, mobile calls, messaging, packet journeys, and protocol behavior are visual simulations. NetViz does not modify the host network or emulate physical hardware. DNS A, AAAA, and PTR requests use Python's socket APIs and therefore the computer's actual configured resolver.

## NetViz 3 highlights

### Colorful Aurora Light interface

- Bright white cards, soft color gradients, high-contrast text, and responsive workspaces.
- No dark application background.
- Graphical diagrams and animated components remain the main teaching method.
- Local account and one-click guest access.

### Network Lab: templates and scratch building

NetViz keeps all five templates:

1. Campus inter-VLAN network
2. STP resilient triangle
3. Branch-office WAN
4. Three-tier data centre
5. Wireless campus

The **Blank topology** command clears the workspace and starts a named custom lab. Students can then add PCs, switches, routers, servers, access points, and phones; move them; create wired/wireless links; configure addresses, VLANs, trunks, routes, STP, MAC learning, port security, and ACLs; send animated packets; and save/load their design.

### Working Mobile Call Control Theatre

The call engine has been rebuilt as a deterministic state machine. **Dial call** runs the complete sequence; **Auto** repeats the complete lesson; **Next stage** supports instructor-led stepping.

1. Dial digits
2. Radio setup
3. SETUP signalling
4. Core processing and authentication
5. Subscriber location lookup
6. Paging
7. Page response
8. Ringing and ringback
9. Answer/CONNECT
10. Bearer, codec, and QoS allocation
11. Bidirectional voice path
12. Release with registration retained

Active phones, towers, core, subscriber database, signalling paths, and voice bearers animate at the correct stage. Registration can be run explicitly, or Dial call registers devices automatically when needed.

### Messaging with visible reverse decapsulation

The sender performs:

```text
Application DATA
→ TCP SEGMENT / UDP DATAGRAM
→ IPv4 PACKET and optional FRAGMENTS
→ Ethernet/Wi-Fi FRAME
→ BITS / SIGNAL
→ network journey
```

The receiver no longer jumps directly to the original message. It visibly performs:

```text
FRAME acceptance and FCS verification
→ PACKET validation / fragment reassembly
→ SEGMENT or DATAGRAM processing
→ original application DATA
```

The receiver card has a live four-stage decapsulation panel. Auto and Next controls animate every transition.

### TCP & UDP all-stage animation

Every TCP and UDP row uses the Web Animations API, so repeated CSS state no longer causes skipped stages.

TCP includes SYN, SYN-ACK, ACK, data, optional loss, retransmission, data acknowledgment, both FIN directions, and final ACK. UDP animates all independent datagrams and the separate application reply. Each stage updates endpoint state, header fields, direction, receive-window visualization, and explanation.

### Five reliable Media Lab studios

All studios use built-in construction and signal diagrams, so they display even when the computer is offline or a reference site blocks image embedding.

1. **Twisted-Pair Copper** — CAT5, CAT5e, CAT6, CAT6a, differential signalling, shielding, PoE
2. **Coaxial Cable** — conductor, dielectric, shield, impedance, RF propagation
3. **Optical Fibre** — core, cladding, single-mode, multimode, animated light
4. **Radio Wireless** — Wi-Fi, Bluetooth, cellular, spectrum, coverage, mobility
5. **Infrared** — emitter, directional beam, receiver, line-of-sight behavior

Each studio includes construction, animated signal movement, engineering properties, typical deployments, decision guidance, and a linked Wikimedia Commons hardware reference.

### Topic-and-level Quiz Centre

Nine topic cards each contain **Beginner**, **Intermediate**, and **Advanced** launch buttons inside the card. Each topic provides 20 concepts at each level, giving 540 unique variants across the academy. Sets contain 5, 10, 15, or 20 questions. IDs do not repeat until the selected topic/level cycle is exhausted, and grading explains every answer.

Topics:

- Network Fundamentals
- Ethernet & Switching
- Routing & WAN
- Network Security
- TCP, UDP & Applications
- IPv4 & Subnetting
- DHCP, DNS & Services
- Wireless & Mobile
- Cabling & Media

### Network Challenge Lab

The previous Progress view has been removed. Its replacement is a practical challenge centre with six guided engineering missions:

- Restore inter-VLAN reachability
- Prevent a Layer 2 loop
- Secure a branch service with ACLs
- Diagnose TCP loss and retransmission
- Design a 50-host subnet
- Trace a DNS resolution

Each mission provides objectives, evidence checks, coaching guidance, and a launcher that opens/configures the correct interactive lab.

## Other labs

- Animated IPv4 subnet studio with binary AND, address boundaries, usable range, and address-space map.
- DHCP pool scanning, DORA, persistent leases, T1, T2, expiry, and release.
- DNS URL/hostname validation, conceptual resolver hierarchy animation, and real system-resolver answers.
- User-specific topology, quiz, lease, and simulation persistence in SQLite.

## Run locally

Python 3.10+ is recommended.

```bash
cd NetViz
python -m venv .venv

# Linux/macOS
source .venv/bin/activate

# Windows PowerShell
# .venv\Scripts\Activate.ps1

pip install -r requirements.txt
python app.py
```

Open <http://127.0.0.1:5000>.

## Deploy on Vercel

NetViz includes Vercel's current FastAPI framework configuration plus a compatibility ASGI entrypoint:

```text
vercel.json
api/index.py
.vercelignore
.python-version
```

Create a stable session secret:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Add it to the Vercel project as `NETVIZ_SECRET_KEY`, then deploy from this directory:

```bash
npm install -g vercel
vercel login
vercel
vercel --prod
```

For the full dashboard, Git integration, local `vercel dev`, verification endpoints, and persistence guidance, read [VERCEL_DEPLOYMENT.md](VERCEL_DEPLOYMENT.md).

### Vercel persistence limitation

Vercel's deployment filesystem is read-only and its writable `/tmp` directory is ephemeral and isolated per function instance. NetViz automatically uses `/tmp/netviz.db`, rehydrates a signed session identity after cold starts, and keeps all graphical simulations operational. However, accounts, saved topologies, DHCP leases, scores, and challenge records are **not guaranteed to persist** across cold starts or instances.

Use a managed database before treating a Vercel deployment as a durable multi-user classroom service. The deployed interface marks this state as **Vercel demo · ephemeral saves**.

DNS lookups on Vercel use the resolver configured inside the Vercel Function runtime, not the website visitor's computer resolver.

### Environment variables

```bash
export NETVIZ_SECRET_KEY='replace-with-a-long-random-value'
export NETVIZ_DATABASE='/path/to/netviz.db'
export NETVIZ_HOST='127.0.0.1'
export NETVIZ_PORT='5000'
export NETVIZ_DEBUG='1'       # development only
export NETVIZ_HTTPS_ONLY='1'  # behind HTTPS
```

## Project structure

```text
NetViz/
├── app.py
├── quiz_bank.py
├── requirements.txt
├── requirements-dev.txt
├── vercel.json
├── VERCEL_DEPLOYMENT.md
├── .python-version
├── .vercelignore
├── api/
│   └── index.py
├── MEDIA_SOURCES.md
├── templates/
│   └── index.html
├── static/
│   ├── css/
│   │   ├── styles.css
│   │   ├── upgrade.css
│   │   └── light.css
│   └── js/
│       ├── app.js
│       ├── upgrade.js
│       └── v3.js
└── tests/
    └── test_app.py
```

## Validate

```bash
pip install -r requirements-dev.txt
pytest -q
python -m py_compile app.py quiz_bank.py
node --check static/js/app.js
node --check static/js/upgrade.js
node --check static/js/v3.js
```

The browser QA flow additionally verifies blank topology creation, all five templates, complete mobile call stages, four receiver decapsulation stages, every TCP/UDP animation row, all five media studios, 9 topic cards with 27 embedded level buttons, and all 6 challenge missions.
