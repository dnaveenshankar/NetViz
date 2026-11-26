"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const uid = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
let authenticatedUser = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.detail || `Request failed (${response.status})`);
  return data;
}

function toast(message, type = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${type === "error" ? "error" : ""}`;
  el.textContent = message;
  $("#toastRegion").append(el);
  setTimeout(() => el.remove(), 3800);
}

async function recordHistory(type, summary, details = {}) {
  if (!authenticatedUser) return;
  try { await api("/api/history", { method: "POST", body: { type, summary, details } }); } catch (_) { /* optional */ }
}

const viewNames = {
  dashboard: ["LEARNING WORKSPACE", "Lab Overview"], topology: ["DESIGN · CONFIGURE · SIMULATE", "Network Lab"],
  mobile: ["CELLULAR NETWORKING", "Mobile Call Lab"], messaging: ["APPLICATION DELIVERY", "Messaging Journey"],
  transport: ["TRANSPORT PROTOCOLS", "TCP & UDP Studio"], subnet: ["IP ADDRESSING", "Subnet Explorer"],
  dhcp: ["ADDRESS CONFIGURATION", "DHCP DORA Lab"], dns: ["NAME RESOLUTION", "DNS Lab"],
  media: ["TRANSMISSION TECHNOLOGY", "Media Lab"], quiz: ["ASSESSMENT", "Quiz Centre"], missions: ["GUIDED PRACTICE", "Network Challenge Lab"]
};

function openView(id) {
  $$(".view").forEach(view => view.classList.toggle("active", view.id === id));
  $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === id));
  const [eyebrow, title] = viewNames[id] || viewNames.dashboard;
  $("#viewEyebrow").textContent = eyebrow; $("#viewTitle").textContent = title;
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (id === "missions") window.netvizLoadMissions?.();
  if (id === "dhcp") loadLeases();
  if (id === "quiz") window.netvizLoadQuizModules?.();
}

$$("[data-open-view]").forEach(b => b.addEventListener("click", () => openView(b.dataset.openView)));
$$(".nav-item").forEach(b => b.addEventListener("click", () => openView(b.dataset.view)));

// Authentication
async function initAuth() {
  try {
    const { user } = await api("/api/me");
    if (user) setUser(user); else $("#authOverlay").classList.remove("hidden");
  } catch (error) { $("#authMessage").textContent = error.message; }
}
function setUser(user) {
  authenticatedUser = user;
  $("#authOverlay").classList.add("hidden");
  $("#usernameLabel").textContent = user.username;
  $("#userInitial").textContent = user.username[0].toUpperCase();
}
async function authenticate(mode) {
  const username = $("#authUsername").value.trim(), password = $("#authPassword").value;
  const msg = $("#authMessage"); msg.textContent = "";
  try {
    const result = await api(`/api/${mode}`, { method: "POST", body: { username, password } });
    setUser(result.user); toast(mode === "register" ? "Local account created." : "Welcome back.");
  } catch (error) { msg.textContent = error.message; }
}
$("#authForm").addEventListener("submit", e => { e.preventDefault(); authenticate("login"); });
$("#registerBtn").addEventListener("click", () => authenticate("register"));
$("#logoutBtn").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); location.reload(); });

// Dialog
const dialog = $("#genericDialog");
function showDialog(title, html) { $("#dialogTitle").textContent = title; $("#dialogBody").innerHTML = html; dialog.showModal(); }
$("[data-close-dialog]").addEventListener("click", () => dialog.close());
$("#helpBtn").addEventListener("click", () => showDialog("How NetViz works", `<p class="muted">NetViz is an educational simulator. It models forwarding and protocol behavior without creating physical network traffic. The DNS lab is the exception: its A, AAAA, and PTR requests use the computer's configured DNS resolver.</p><div class="explanation-box"><b>Try this path</b><br>Open Network Lab → load Campus VLAN demo → send ICMP → inspect animated hops and event cards → select devices to change VLAN, route, and ACL configuration.</div>`));

// ---------------- Topology Lab ----------------
const NS = "http://www.w3.org/2000/svg";
const deviceTypes = {
  pc: { label: "PC", accent: "#22d3ee" }, switch: { label: "Switch", accent: "#9a7cff" }, router: { label: "Router", accent: "#ffbd59" },
  server: { label: "Server", accent: "#42dc9a" }, accesspoint: { label: "Wireless AP", accent: "#5eead4" }, phone: { label: "IP Phone", accent: "#f472b6" }
};
let topology = { name: "Untitled topology", nodes: [], links: [], events: [] };
let selectedNodeId = null, interactionMode = "select", pendingLinkNode = null, dragState = null, currentTopologyId = null, inspectorTab = "config";
const svg = $("#topologyCanvas"), nodesLayer = $("#nodesLayer"), linksLayer = $("#linksLayer"), packetsLayer = $("#packetsLayer");

function deviceIcon(type, large = false) {
  const size = large ? 28 : 24;
  const map = {
    pc: `<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>`,
    switch: `<rect x="2" y="7" width="20" height="11" rx="2"/><path d="M5 11h2M9 11h2M13 11h2M17 11h2M5 15h2M9 15h2M13 15h2M17 15h2"/>`,
    router: `<circle cx="12" cy="12" r="9"/><path d="M7 9l3-3m-3 3h4M17 15l-3 3m3-3h-4M15 7l3 3m-3-3v4M9 17l-3-3m3 3v-4"/>`,
    server: `<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M8 7h8M8 12h8M8 17h8"/><circle cx="9" cy="5" r=".5"/>`,
    accesspoint: `<path d="M5 9a10 10 0 0114 0M8 12a6 6 0 018 0M11 15a2 2 0 012 0"/><circle cx="12" cy="18" r="2"/>`,
    phone: `<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M9 5h6M10 19h4"/>`
  };
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${map[type]}</svg>`;
}

function initPalette() {
  const palette = $("#devicePalette");
  Object.entries(deviceTypes).forEach(([type, info]) => {
    const b = document.createElement("button"); b.className = "device-tile"; b.draggable = true; b.dataset.type = type;
    b.innerHTML = `${deviceIcon(type)}<span>${info.label}</span>`;
    b.addEventListener("click", () => addNode(type, 280 + Math.random() * 420, 200 + Math.random() * 250));
    b.addEventListener("dragstart", e => e.dataTransfer.setData("device/type", type)); palette.append(b);
  });
  svg.addEventListener("dragover", e => e.preventDefault());
  svg.addEventListener("drop", e => { e.preventDefault(); const type = e.dataTransfer.getData("device/type"); if (type) { const p = svgPoint(e); addNode(type, p.x, p.y); } });
}

function defaultConfig(type, index) {
  const ipBase = type === "router" ? `10.${index}.0.1` : `192.168.10.${10 + index}`;
  const common = { ip: ipBase, mask: "255.255.255.0", gateway: type === "router" ? "" : "192.168.10.1", vlan: 10, dhcp: false, mac: randomMac() };
  if (type === "switch") return { ...common, ip: `192.168.10.${240 + index}`, vlans: [1, 10, 20], stp: true, rootPriority: 32768, portSecurity: true, sticky: true, maxSecureMac: 2, allowedVlans: [10, 20], ports: [{ name: "Fa0/1", mode: "access", accessVlan: 10, allowed: [] }, { name: "Fa0/2", mode: "access", accessVlan: 20, allowed: [] }, { name: "Gi0/1", mode: "trunk", accessVlan: 1, allowed: [10, 20] }], macTable: [] };
  if (type === "router") return { ...common, interfaces: [{ name: "G0/0.10", ip: "192.168.10.1", prefix: 24, vlan: 10 }, { name: "G0/0.20", ip: "192.168.20.1", prefix: 24, vlan: 20 }], routes: [{ network: "0.0.0.0/0", nextHop: "203.0.113.1", interface: "G0/1" }], acl: [] };
  if (type === "server") return { ...common, ip: "192.168.20.10", vlan: 20, services: ["DNS", "HTTPS", "DHCP"] };
  if (type === "accesspoint") return { ...common, ssid: "NetViz-Lab", security: "WPA3", channel: 6 };
  return common;
}
function randomMac() { return "02:" + Array.from({ length: 5 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join(":"); }
function addNode(type, x, y, config = null, id = null, name = null) {
  const count = topology.nodes.filter(n => n.type === type).length + 1;
  const node = { id: id || uid(type), type, name: name || `${deviceTypes[type].label} ${count}`, x: Math.max(65, Math.min(1135, x)), y: Math.max(60, Math.min(665, y)), config: config || defaultConfig(type, count) };
  topology.nodes.push(node); selectedNodeId = node.id; renderTopology(); renderInspector(); return node;
}
function addLink(a, b, medium = "wired", portA = "auto", portB = "auto") {
  if (a === b || topology.links.some(l => (l.a === a && l.b === b) || (l.a === b && l.b === a))) return;
  topology.links.push({ id: uid("link"), a, b, medium, portA, portB, blocked: false }); renderTopology();
}
function svgPoint(event) { const p = svg.createSVGPoint(); p.x = event.clientX; p.y = event.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); }
function createSvg(tag, attrs = {}) { const el = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v)); return el; }

function renderTopology() {
  applyStp();
  linksLayer.innerHTML = ""; nodesLayer.innerHTML = "";
  const nodes = Object.fromEntries(topology.nodes.map(n => [n.id, n]));
  topology.links.forEach(link => {
    const a = nodes[link.a], b = nodes[link.b]; if (!a || !b) return;
    const line = createSvg("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `net-link ${link.medium === "wireless" ? "wireless" : ""} ${link.blocked ? "blocked" : ""}`, "data-id": link.id });
    linksLayer.append(line);
  });
  topology.nodes.forEach(node => {
    const g = createSvg("g", { class: `network-node ${node.id === selectedNodeId ? "selected" : ""}`, transform: `translate(${node.x} ${node.y})`, "data-id": node.id, tabindex: 0 });
    const body = createSvg(node.type === "router" ? "circle" : "rect", node.type === "router" ? { cx: 0, cy: 0, r: 34, class: "node-body" } : { x: -38, y: -30, width: 76, height: 60, rx: 12, class: "node-body" });
    body.style.stroke = deviceTypes[node.type].accent; g.append(body);
    const icon = createSvg("g", { class: "node-icon", transform: "translate(-12 -12)" }); icon.innerHTML = deviceIcon(node.type, true).replace(/^<svg[^>]*>|<\/svg>$/g, ""); g.append(icon);
    const label = createSvg("text", { x: 0, y: 50, class: "node-label" }); label.textContent = node.name; g.append(label);
    const ip = createSvg("text", { x: 0, y: 63, class: "node-ip" }); ip.textContent = node.config.ip || node.config.interfaces?.[0]?.ip || "unconfigured"; g.append(ip);
    g.append(createSvg("circle", { cx: 30, cy: -24, r: 5, class: "status-ring" }));
    g.addEventListener("pointerdown", nodePointerDown); g.addEventListener("click", nodeClick); nodesLayer.append(g);
  });
  $("#canvasHint").classList.toggle("hidden", topology.nodes.length > 0);
  $("#nodeCount").textContent = `${topology.nodes.length} device${topology.nodes.length === 1 ? "" : "s"}`;
  $("#linkCount").textContent = `${topology.links.length} link${topology.links.length === 1 ? "" : "s"}`;
  updatePacketSelects();
}
function nodeClick(e) {
  e.stopPropagation(); const id = e.currentTarget.dataset.id;
  if (interactionMode === "wire" || interactionMode === "wireless") {
    if (!pendingLinkNode) { pendingLinkNode = id; selectedNodeId = id; toast("Select the second endpoint."); }
    else { addLink(pendingLinkNode, id, interactionMode === "wireless" ? "wireless" : "wired"); pendingLinkNode = null; }
  } else { selectedNodeId = id; }
  renderTopology(); renderInspector();
}
function nodePointerDown(e) {
  if (interactionMode !== "select") return;
  const id = e.currentTarget.dataset.id, node = topology.nodes.find(n => n.id === id), start = svgPoint(e);
  selectedNodeId = id; dragState = { node, dx: start.x - node.x, dy: start.y - node.y };
  e.currentTarget.setPointerCapture(e.pointerId); renderInspector();
}
svg.addEventListener("pointermove", e => { if (!dragState) return; const p = svgPoint(e); dragState.node.x = Math.max(50, Math.min(1150, p.x - dragState.dx)); dragState.node.y = Math.max(45, Math.min(670, p.y - dragState.dy)); renderTopology(); });
svg.addEventListener("pointerup", () => dragState = null);
svg.addEventListener("click", e => { if (e.target === svg || e.target.tagName === "rect" && e.target.getAttribute("fill") === "url(#grid)") { selectedNodeId = null; renderTopology(); renderInspector(); } });

function setMode(mode) {
  interactionMode = mode; pendingLinkNode = null;
  [["selectMode", "select"], ["wireMode", "wire"], ["wirelessMode", "wireless"]].forEach(([id, m]) => $("#" + id).classList.toggle("active", m === mode));
}
$("#selectMode").onclick = () => setMode("select"); $("#wireMode").onclick = () => setMode("wire"); $("#wirelessMode").onclick = () => setMode("wireless");
$("#deleteSelection").onclick = () => { if (!selectedNodeId) return toast("Select a device first.", "error"); topology.nodes = topology.nodes.filter(n => n.id !== selectedNodeId); topology.links = topology.links.filter(l => l.a !== selectedNodeId && l.b !== selectedNodeId); selectedNodeId = null; renderTopology(); renderInspector(); };
$("#clearCanvas").onclick = () => { topology = { name: "Untitled topology", nodes: [], links: [], events: [] }; currentTopologyId = null; selectedNodeId = null; renderTopology(); renderInspector(); };
$("#newTopology").onclick = $("#clearCanvas").onclick;

$$('[data-inspector]').forEach(b => b.onclick = () => { inspectorTab = b.dataset.inspector; $$('[data-inspector]').forEach(x => x.classList.toggle("active", x === b)); renderInspector(); });
function renderInspector() {
  const body = $("#inspectorBody"), node = topology.nodes.find(n => n.id === selectedNodeId);
  if (inspectorTab === "events") { body.innerHTML = topology.events.length ? topology.events.slice().reverse().map(e => `<div class="event-card ${e.error ? "error" : ""}"><b>${escapeHtml(e.title)}</b><span>${escapeHtml(e.text)}</span></div>`).join("") : `<div class="empty-state">Packet-processing events will appear here.</div>`; return; }
  if (!node) { body.innerHTML = `<div class="empty-state">Select a device to configure it and inspect tables.</div>`; return; }
  if (inspectorTab === "tables") { renderTables(body, node); return; }
  const c = node.config;
  let extra = "";
  if (node.type === "switch") extra = `<h4>Switching & VLANs</h4><label>VLAN database (comma separated)<input data-config="vlans" value="${c.vlans.join(", ")}"></label><label>802.1Q allowed VLANs<input data-config="allowedVlans" value="${c.allowedVlans.join(", ")}"></label><label>Ports (name,mode,access VLAN,allowed VLANs)<textarea id="switchPortsInput" rows="4">${(c.ports || []).map(p => `${p.name},${p.mode},${p.accessVlan || 1},${(p.allowed || []).join("|")}`).join("\n")}</textarea></label><div class="config-grid"><label>STP<select data-config="stp"><option value="true" ${c.stp ? "selected" : ""}>Enabled</option><option value="false" ${!c.stp ? "selected" : ""}>Disabled</option></select></label><label>Priority<input type="number" data-config="rootPriority" value="${c.rootPriority}"></label></div><div class="config-grid"><label>Port security<select data-config="portSecurity"><option value="true" ${c.portSecurity ? "selected" : ""}>Enabled</option><option value="false" ${!c.portSecurity ? "selected" : ""}>Disabled</option></select></label><label>Max secure MACs<input type="number" data-config="maxSecureMac" value="${c.maxSecureMac || 2}" min="1" max="32"></label></div><label>Sticky learning<select data-config="sticky"><option value="true" ${c.sticky ? "selected" : ""}>Enabled</option><option value="false" ${!c.sticky ? "selected" : ""}>Disabled</option></select></label><button class="primary wide small" id="applySwitchPorts">Apply access & trunk ports</button><button class="ghost wide" id="addStaticMac">Add static MAC entry</button>`;
  if (node.type === "router") extra = `<h4>Router interfaces</h4><label>Interfaces (name,ip/prefix,vlan)<textarea id="interfacesInput" rows="4">${c.interfaces.map(i => `${i.name},${i.ip}/${i.prefix},${i.vlan || ""}`).join("\n")}</textarea></label><label>Static routes (network,next hop,interface)<textarea id="routesInput" rows="4">${c.routes.map(r => `${r.network},${r.nextHop},${r.interface}`).join("\n")}</textarea></label><h4>Access Control List</h4><label>Rules: action,src,dst,protocol,port<textarea id="aclInput" rows="4" placeholder="deny,192.168.10.0/24,any,TCP,23">${(c.acl || []).map(r => `${r.action},${r.src},${r.dst},${r.protocol},${r.port || "any"}`).join("\n")}</textarea></label><button class="primary wide small" id="applyRouterConfig">Apply routing & ACL</button>`;
  if (node.type === "accesspoint") extra = `<h4>Wireless</h4><label>SSID<input data-config="ssid" value="${c.ssid}"></label><div class="config-grid"><label>Security<select data-config="security"><option>WPA3</option><option>WPA2</option><option>Open</option></select></label><label>Channel<input type="number" data-config="channel" value="${c.channel}" min="1" max="165"></label></div>`;
  body.innerHTML = `<p class="eyebrow">${deviceTypes[node.type].label.toUpperCase()}</p><h4>${escapeHtml(node.name)}</h4><label>Device name<input data-node="name" value="${escapeAttr(node.name)}"></label>${node.type !== "router" ? `<div class="config-grid"><label>IPv4 address<input data-config="ip" value="${c.ip || ""}"></label><label>Subnet mask<input data-config="mask" value="${c.mask || ""}"></label></div><label>Default gateway<input data-config="gateway" value="${c.gateway || ""}"></label><div class="config-grid"><label>VLAN<input type="number" data-config="vlan" value="${c.vlan || 1}"></label><label>Addressing<select data-config="dhcp"><option value="false" ${!c.dhcp ? "selected" : ""}>Static</option><option value="true" ${c.dhcp ? "selected" : ""}>DHCP</option></select></label></div><label>MAC address<input data-config="mac" value="${c.mac || ""}"></label>` : ""}${extra}`;
  $$('[data-node="name"]', body).forEach(input => input.onchange = () => { node.name = input.value.trim() || node.name; renderTopology(); });
  $$('[data-config]', body).forEach(input => input.onchange = () => { let v = input.value; if (["true", "false"].includes(v)) v = v === "true"; if (["vlan", "channel", "rootPriority", "maxSecureMac"].includes(input.dataset.config)) v = Number(v); if (["vlans", "allowedVlans"].includes(input.dataset.config)) v = v.split(",").map(Number).filter(Boolean); c[input.dataset.config] = v; renderTopology(); renderInspector(); });
  const staticBtn = $("#addStaticMac"); if (staticBtn) staticBtn.onclick = () => { c.macTable.push({ mac: randomMac(), port: `Fa0/${c.macTable.length + 1}`, vlan: c.vlans[1] || 1, type: "STATIC" }); renderInspector(); };
  const applyPorts = $("#applySwitchPorts"); if (applyPorts) applyPorts.onclick = () => {
    try {
      c.ports = $("#switchPortsInput").value.split("\n").filter(Boolean).map(line => { const [name, mode, accessVlan, allowed = ""] = line.split(",").map(s => s.trim()); if (!name || !["access", "trunk"].includes(mode)) throw new Error(); return { name, mode, accessVlan: Number(accessVlan) || 1, allowed: allowed.split("|").map(Number).filter(Boolean) }; });
      toast("Access and 802.1Q trunk ports applied."); renderInspector();
    } catch (_) { toast("Use: port,access|trunk,access VLAN,allowed VLANs separated by |", "error"); }
  };
  const apply = $("#applyRouterConfig"); if (apply) apply.onclick = () => {
    try {
      c.interfaces = $("#interfacesInput").value.split("\n").filter(Boolean).map(line => { const [name, ipPrefix, vlan] = line.split(",").map(s => s.trim()); const [ip, prefix] = ipPrefix.split("/"); return { name, ip, prefix: Number(prefix), vlan: Number(vlan) || null }; });
      c.routes = $("#routesInput").value.split("\n").filter(Boolean).map(line => { const [network, nextHop, interfaceName] = line.split(",").map(s => s.trim()); return { network, nextHop, interface: interfaceName }; });
      c.acl = $("#aclInput").value.split("\n").filter(Boolean).map(line => { const [action, src, dst, protocol, port] = line.split(",").map(s => s.trim()); return { action: action.toLowerCase(), src, dst, protocol: protocol.toUpperCase(), port: port || "any" }; });
      renderTopology(); toast("Router interfaces, routes, and ACL applied.");
    } catch (_) { toast("Check the configuration line format.", "error"); }
  };
}
function renderTables(body, node) {
  if (node.type === "switch") {
    const rows = node.config.macTable || [];
    body.innerHTML = `<p class="eyebrow">MAC ADDRESS TABLE</p><div class="data-table"><table><thead><tr><th>VLAN</th><th>MAC</th><th>Port</th><th>Type</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r.vlan}</td><td>${r.mac}</td><td>${r.port}</td><td>${r.type}</td></tr>`).join("") || `<tr><td colspan="4">Send traffic to learn MACs.</td></tr>`}</tbody></table></div><h4>Port configuration</h4><div class="data-table"><table><thead><tr><th>Port</th><th>Mode</th><th>VLANs</th></tr></thead><tbody>${(node.config.ports || []).map(p => `<tr><td>${p.name}</td><td>${p.mode}</td><td>${p.mode === "trunk" ? (p.allowed || []).join(",") : p.accessVlan}</td></tr>`).join("")}</tbody></table></div><h4>Spanning Tree</h4><div class="tag-list"><span class="tag">Priority ${node.config.rootPriority}</span><span class="tag">${node.config.stp ? "Enabled" : "Disabled"}</span><span class="tag">${topology.links.some(l => l.blocked && (l.a === node.id || l.b === node.id)) ? "One alternate blocked" : "Forwarding"}</span></div>`;
  } else if (node.type === "router") {
    const connected = node.config.interfaces.map(i => ({ network: `${networkAddress(i.ip, i.prefix)}/${i.prefix}`, nextHop: "connected", interface: i.name, source: "C" }));
    const routes = [...connected, ...node.config.routes.map(r => ({ ...r, source: "S" }))];
    body.innerHTML = `<p class="eyebrow">ROUTING TABLE</p><div class="data-table"><table><thead><tr><th>Type</th><th>Prefix</th><th>Next hop / Interface</th></tr></thead><tbody>${routes.map(r => `<tr><td>${r.source}</td><td>${r.network}</td><td>${r.nextHop === "connected" ? r.interface : `${r.nextHop} · ${r.interface}`}</td></tr>`).join("")}</tbody></table></div><div class="explanation-box">The route with the longest matching prefix is selected. Connected routes are generated by configured interfaces; static routes are manually supplied.</div>`;
  } else body.innerHTML = `<p class="eyebrow">DEVICE STATE</p><div class="data-table"><table><tr><th>Property</th><th>Value</th></tr>${Object.entries(node.config).filter(([,v]) => typeof v !== "object").map(([k,v]) => `<tr><td>${k}</td><td>${escapeHtml(String(v))}</td></tr>`).join("")}</table></div>`;
}
function networkAddress(ip, prefix) { const n = ipToInt(ip), mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0; return intToIp((n & mask) >>> 0); }
function ipToInt(ip) { return ip.split(".").reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0); }
function intToIp(n) { return [24,16,8,0].map(s => (n >>> s) & 255).join("."); }
function ipInNetwork(ip, cidr) { try { const [base, p] = cidr.split("/"); const prefix = Number(p); return networkAddress(ip, prefix) === networkAddress(base, prefix); } catch (_) { return false; } }

function applyStp() {
  topology.links.forEach(l => l.blocked = false);
  const switches = topology.nodes.filter(n => n.type === "switch" && n.config.stp);
  if (switches.length < 3) return;
  const switchIds = new Set(switches.map(s => s.id)); const swLinks = topology.links.filter(l => switchIds.has(l.a) && switchIds.has(l.b));
  if (swLinks.length >= switches.length) {
    const root = switches.slice().sort((a,b) => a.config.rootPriority - b.config.rootPriority || a.config.mac.localeCompare(b.config.mac))[0];
    const candidate = swLinks.filter(l => l.a !== root.id && l.b !== root.id).pop() || swLinks[swLinks.length - 1]; if (candidate) candidate.blocked = true;
  }
}
function updatePacketSelects() {
  const endpoints = topology.nodes.filter(n => ["pc", "server", "phone"].includes(n.type));
  [$("#packetSource"), $("#packetDestination")].forEach((select, index) => { const old = select.value; select.innerHTML = endpoints.map(n => `<option value="${n.id}">${escapeHtml(n.name)} · ${n.config.ip}</option>`).join(""); if (endpoints.some(n => n.id === old)) select.value = old; else if (index === 1 && endpoints[1]) select.value = endpoints[1].id; });
}
function neighbors(id) { return topology.links.filter(l => !l.blocked && (l.a === id || l.b === id)).map(l => l.a === id ? l.b : l.a); }
function shortestPath(start, end) {
  const queue = [[start]], visited = new Set([start]);
  while (queue.length) { const path = queue.shift(), last = path[path.length - 1]; if (last === end) return path; for (const n of neighbors(last)) if (!visited.has(n)) { visited.add(n); queue.push([...path, n]); } }
  return null;
}
function addEvent(title, text, error = false) { const e = { title, text, error, time: Date.now() }; topology.events.push(e); return e; }
function checkAcl(router, src, dst, protocol, port) {
  for (const rule of router.config.acl || []) {
    const srcMatch = rule.src === "any" || ipInNetwork(src, rule.src), dstMatch = rule.dst === "any" || ipInNetwork(dst, rule.dst), protoMatch = rule.protocol === "IP" || rule.protocol === "ANY" || rule.protocol === protocol, portMatch = String(rule.port).toLowerCase() === "any" || Number(rule.port) === Number(port);
    if (srcMatch && dstMatch && protoMatch && portMatch) return rule.action !== "deny";
  }
  return !(router.config.acl || []).length;
}
function bestRoute(router, destinationIp) {
  const routes = [...router.config.interfaces.map(i => ({ network: `${networkAddress(i.ip, i.prefix)}/${i.prefix}`, nextHop: "connected", interface: i.name })), ...(router.config.routes || [])];
  return routes.filter(r => ipInNetwork(destinationIp, r.network)).sort((a,b) => Number(b.network.split("/")[1]) - Number(a.network.split("/")[1]))[0] || null;
}
async function sendPacket() {
  const src = topology.nodes.find(n => n.id === $("#packetSource").value), dst = topology.nodes.find(n => n.id === $("#packetDestination").value), protocol = $("#packetProtocol").value, port = Number($("#packetPort").value);
  if (!src || !dst || src.id === dst.id) return toast("Choose two different endpoint devices.", "error");
  topology.events = []; addEvent("L7/L4 payload", `${protocol} traffic created from ${src.config.ip} to ${dst.config.ip}${protocol === "ICMP" ? "" : ` port ${port}`}.`);
  const path = shortestPath(src.id, dst.id);
  if (!path) { addEvent("No Layer 1/2 path", "No active link path exists between the endpoints. Check cables, wireless links, and STP state.", true); renderEvents(); renderInspector(); return; }
  let blocked = false; const pathNodes = path.map(id => topology.nodes.find(n => n.id === id));
  for (let i = 0; i < pathNodes.length; i++) {
    const node = pathNodes[i];
    if (node.type === "switch") {
      if (!node.config.vlans.includes(Number(src.config.vlan))) { addEvent(`${node.name}: VLAN mismatch`, `VLAN ${src.config.vlan} is not present in this switch VLAN database. Frame dropped.`, true); blocked = true; break; }
      const alreadyLearned = node.config.macTable.some(r => r.mac === src.config.mac);
      if (!alreadyLearned && node.config.portSecurity && node.config.macTable.filter(r => r.type !== "STATIC").length >= (node.config.maxSecureMac || 2)) { addEvent(`${node.name}: port-security violation`, `The secure MAC limit of ${node.config.maxSecureMac || 2} was reached. The new source MAC was restricted.`, true); blocked = true; break; }
      if (!alreadyLearned) node.config.macTable.push({ mac: src.config.mac, vlan: src.config.vlan, port: `Fa0/${Math.max(1, i)}`, type: node.config.sticky ? "STICKY" : "DYNAMIC" });
      addEvent(`${node.name}: MAC learning`, `Learned source ${src.config.mac} in VLAN ${src.config.vlan}; forwarding toward ${dst.config.mac}.`);
      const next = pathNodes[i + 1];
      if (next && ["switch", "router"].includes(next.type)) {
        if (!node.config.allowedVlans.includes(Number(src.config.vlan))) { addEvent(`${node.name}: trunk VLAN denied`, `The 802.1Q trunk allowed list does not include VLAN ${src.config.vlan}.`, true); blocked = true; break; }
        addEvent(`${node.name}: 802.1Q tagging`, `The trunk frame carries VLAN tag ${src.config.vlan}; access links send endpoint frames untagged.`);
      }
    }
    if (node.type === "router") {
      if (!checkAcl(node, src.config.ip, dst.config.ip, protocol, port)) { addEvent(`${node.name}: ACL deny`, `A top-down ACL match denied ${protocol} ${src.config.ip} → ${dst.config.ip}:${port}.`, true); blocked = true; break; }
      const route = bestRoute(node, dst.config.ip);
      if (!route) { addEvent(`${node.name}: no route`, `No routing-table prefix matches ${dst.config.ip}. Packet dropped.`, true); blocked = true; break; }
      addEvent(`${node.name}: longest-prefix match`, `Selected ${route.network} via ${route.nextHop === "connected" ? route.interface : `${route.nextHop} on ${route.interface}`}.`);
      addEvent("Layer 2 rewrite", `The router removes the incoming frame, keeps the IP packet, and creates a new frame for the next hop.`);
    }
  }
  if (!blocked && src.config.vlan !== dst.config.vlan && !pathNodes.some(n => n.type === "router")) { addEvent("Inter-VLAN routing required", `Source VLAN ${src.config.vlan} and destination VLAN ${dst.config.vlan} are isolated without a router in the path.`, true); blocked = true; }
  if (!blocked) addEvent("Destination delivery", `${dst.name} accepts the packet and decapsulates it up the protocol stack.`);
  renderEvents(); renderInspector(); await animatePacket(pathNodes, blocked); recordHistory("packet", `${protocol} ${src.name} → ${dst.name}: ${blocked ? "blocked" : "delivered"}`, { path: pathNodes.map(n => n.name), events: topology.events });
}
function renderEvents() { $("#eventStrip").innerHTML = topology.events.map(e => `<div class="event-card ${e.error ? "error" : ""}"><b>${escapeHtml(e.title)}</b><span>${escapeHtml(e.text)}</span></div>`).join(""); }
async function animatePacket(pathNodes, blocked) {
  packetsLayer.innerHTML = ""; const g = createSvg("g", { class: "packet-visual" }); g.append(createSvg("circle", { r: 10 })); const t = createSvg("text", { y: 3 }); t.textContent = "PDU"; g.append(t); packetsLayer.append(g);
  for (let i = 0; i < pathNodes.length; i++) { const n = pathNodes[i]; g.setAttribute("transform", `translate(${n.x} ${n.y})`); if (i < pathNodes.length - 1) await tweenSvg(g, n, pathNodes[i + 1], 550); }
  if (blocked) { g.querySelector("circle").style.fill = "#ff647c"; await sleep(500); } g.remove();
}
function tweenSvg(el, a, b, duration) { return new Promise(resolve => { const start = performance.now(); function frame(now) { const p = Math.min(1, (now - start) / duration), eased = p < .5 ? 2*p*p : 1-Math.pow(-2*p+2,2)/2; el.setAttribute("transform", `translate(${a.x + (b.x-a.x)*eased} ${a.y + (b.y-a.y)*eased})`); if (p < 1) requestAnimationFrame(frame); else resolve(); } requestAnimationFrame(frame); }); }
$("#sendPacket").onclick = sendPacket;

function campusDemo() {
  topology = { name: "Campus Inter-VLAN Lab", nodes: [], links: [], events: [] }; currentTopologyId = null;
  const pc1 = addNode("pc", 110, 180, { ...defaultConfig("pc",1), ip:"192.168.10.11", vlan:10 }, null, "Student PC");
  const pc2 = addNode("pc", 110, 500, { ...defaultConfig("pc",2), ip:"192.168.20.22", gateway:"192.168.20.1", vlan:20 }, null, "Lab PC");
  const sw1 = addNode("switch", 390, 330, null, null, "Access SW1");
  const r1 = addNode("router", 690, 330, null, null, "Router R1");
  const srv = addNode("server", 1010, 330, null, null, "Learning Server");
  addLink(pc1.id, sw1.id); addLink(pc2.id, sw1.id); addLink(sw1.id, r1.id); addLink(r1.id, srv.id); selectedNodeId = null; renderTopology(); renderInspector(); toast("Campus VLAN demo loaded.");
}
function loopDemo() {
  topology = { name: "STP Redundant Triangle", nodes: [], links: [], events: [] }; currentTopologyId = null;
  const a = addNode("switch", 300, 170, null, null, "SW Root"); a.config.rootPriority = 24576;
  const b = addNode("switch", 180, 480, null, null, "SW Access A"); const c = addNode("switch", 520, 480, null, null, "SW Access B");
  const p = addNode("pc", 760, 480, null, null, "Engineering PC"); addLink(a.id,b.id); addLink(a.id,c.id); addLink(b.id,c.id); addLink(c.id,p.id); selectedNodeId = null; renderTopology(); renderInspector(); toast("STP computed a loop-free forwarding tree.");
}
if ($("#loadCampusDemo")) $("#loadCampusDemo").onclick = campusDemo;
if ($("#loadLoopDemo")) $("#loadLoopDemo").onclick = loopDemo;
$("#saveTopology").onclick = () => {
  showDialog("Save topology", `<label>Topology name<input id="saveName" value="${escapeAttr(topology.name)}" maxlength="80"></label><button id="confirmSave" class="primary wide">Save to SQLite</button>`);
  $("#confirmSave").onclick = async () => { try { topology.name = $("#saveName").value.trim() || "Untitled topology"; const payload = { name: topology.name, data: topology }; let result; if (currentTopologyId) result = await api(`/api/topologies/${currentTopologyId}`, { method:"PUT", body:payload }); else { result = await api("/api/topologies", { method:"POST", body:payload }); currentTopologyId = result.id; } dialog.close(); toast("Topology saved."); } catch(e) { toast(e.message,"error"); } };
};
$("#loadTopology").onclick = async () => { try { const { topologies } = await api("/api/topologies"); showDialog("Load saved topology", `<div class="saved-list">${topologies.map(t => `<button data-load-id="${t.id}"><span>${escapeHtml(t.name)}</span><small>${new Date(t.updated_at).toLocaleString()}</small></button>`).join("") || `<div class="empty-state">No saved topologies yet.</div>`}</div>`); $$('[data-load-id]', dialog).forEach(b => b.onclick = async () => { const result = await api(`/api/topologies/${b.dataset.loadId}`); topology = result.data; currentTopologyId = result.id; selectedNodeId = null; dialog.close(); renderTopology(); renderInspector(); toast("Topology loaded."); }); } catch(e) { toast(e.message,"error"); } };
$("#zoomSlider").oninput = e => { const s = Number(e.target.value)/100; svg.style.transform = `scale(${s})`; svg.style.transformOrigin = "center"; };
$("#fitCanvas").onclick = () => { $("#zoomSlider").value = 100; svg.style.transform = "scale(1)"; };

// ---------------- Mobile simulator ----------------
const mobileState = { registered:false, inCall:false, positions:{ A:{x:100,y:420}, B:{x:845,y:420} }, serving:{ A:null,B:null } };
function phoneTower(pos) { const centers = [{name:"Tower Alpha",x:230,y:280},{name:"Tower Beta",x:730,y:280}]; return centers.slice().sort((a,b) => Math.hypot(pos.x-a.x,pos.y-a.y)-Math.hypot(pos.x-b.x,pos.y-b.y))[0]; }
function signalStrength(pos, tower) { return Math.max(5, Math.round(100 - Math.hypot(pos.x-tower.x,pos.y-tower.y)/4.2)); }
function updateMobileState(phone, moved = false) {
  const pos = mobileState.positions[phone], tower = phoneTower(pos), old = mobileState.serving[phone]; mobileState.serving[phone] = tower.name;
  $(phone === "A" ? "#signalA" : "#signalB").value = signalStrength(pos,tower);
  if (mobileState.registered) { const label = $(phone === "A" ? "#regA" : "#regB"); label.textContent = tower.name; label.classList.add("registered"); if (moved && old && old !== tower.name) { addCallEvent("Handover", `${phone === "A" ? "Asha" : "Ravi"} moved from ${old} to ${tower.name}. Radio resources and the active context were transferred.`); drawMobileLinks(mobileState.inCall); recordHistory("mobile", `Cellular handover: ${old} → ${tower.name}`); } }
}
function initMobileDrag() {
  $$(".phone.draggable").forEach(phone => { let moving=false, offset={x:0,y:0}; phone.addEventListener("pointerdown", e => { moving=true; const p=mobileSvgPoint(e); const state=mobileState.positions[phone.dataset.phone]; offset={x:p.x-state.x,y:p.y-state.y}; phone.setPointerCapture(e.pointerId); }); phone.addEventListener("pointermove", e => { if(!moving)return; const p=mobileSvgPoint(e), key=phone.dataset.phone; mobileState.positions[key]={x:Math.max(20,Math.min(925,p.x-offset.x)),y:Math.max(120,Math.min(455,p.y-offset.y))}; const pos=mobileState.positions[key]; phone.setAttribute("transform",`translate(${pos.x} ${pos.y})`); updateMobileState(key,true); }); phone.addEventListener("pointerup",()=>moving=false); });
}
function mobileSvgPoint(e){const canvas=$("#mobileCanvas"),p=canvas.createSVGPoint();p.x=e.clientX;p.y=e.clientY;return p.matrixTransform(canvas.getScreenCTM().inverse())}
function addCallEvent(title,text){const t=$("#callTimeline");if(t.querySelector(".empty-state"))t.innerHTML="";t.insertAdjacentHTML("beforeend",`<div class="timeline-event"><b>${escapeHtml(title)}</b>${escapeHtml(text)}</div>`);t.scrollTop=t.scrollHeight}
function drawMobileLinks(call=false){const layer=$("#mobileLinks");layer.innerHTML="";for(const key of ["A","B"]){const p=mobileState.positions[key],tower=phoneTower(p);layer.append(createSvg("line",{x1:p.x+28,y1:p.y,x2:tower.x,y2:tower.y+70,class:`mobile-signal ${call?"call":""}`}));}layer.append(createSvg("path",{d:"M270 250 Q500 70 690 250",class:`mobile-signal ${call?"call":""}`}));}
$("#registerMobiles").onclick=async()=>{mobileState.registered=true;$("#callTimeline").innerHTML="";drawMobileLinks(false);for(const key of ["A","B"]){updateMobileState(key);addCallEvent("Cell search",`${key==="A"?"Asha":"Ravi"} measures nearby broadcast channels and selects ${mobileState.serving[key]}.`);await sleep(400);addCallEvent("Location update",`Subscriber identity is authenticated and registered through the Mobile Switching Centre.`);await sleep(350)}toast("Both mobile devices are registered.");recordHistory("mobile","Two devices registered with cellular towers",mobileState.serving)};
$("#startCall").onclick=async()=>{if(!mobileState.registered)return toast("Register the devices first.","error");if(mobileState.inCall)return;mobileState.inCall=true;const direction=$("#callDirection").value,from=direction==="A-B"?"Asha":"Ravi",to=direction==="A-B"?"Ravi":"Asha";const receiver=direction==="A-B"?$("#phoneB"):$("#phoneA");const steps=[["Call request",`${from} sends call setup signalling through the serving tower.`],["Subscriber lookup",`The switching centre locates ${to}'s registered serving tower.`],["Paging",`${to}'s tower broadcasts a paging request in its location area.`],["Ringing",`${to}'s device responds and alerts the user.`],["Call established",`Traffic channels are assigned; the voice path is active.`]];for(const [title,text]of steps){addCallEvent(title,text);if(title==="Ringing")receiver.classList.add("ringing");await sleep(700)}receiver.classList.remove("ringing");drawMobileLinks(true);recordHistory("mobile",`Call established: ${from} → ${to}`,{serving:mobileState.serving})};
$("#endCall").onclick=()=>{if(!mobileState.inCall)return;mobileState.inCall=false;drawMobileLinks(false);addCallEvent("Release","Call resources and traffic channels are released; registration remains active.");recordHistory("mobile","Mobile call released")};

// ---------------- Messaging ----------------
let messagingBusy=false;
$("#sendMessage").onclick=async()=>{if(messagingBusy)return;const payload=$("#messagePayload").value.trim();if(!payload)return;messagingBusy=true;$("#senderChat").querySelector(".chat-placeholder")?.remove();$("#senderChat").insertAdjacentHTML("beforeend",`<div class="bubble sent">${escapeHtml(payload)}<small>sending…</small></div>`);const layers=$$("#encapsulationStack>div");const explanations={Application:"Application data is prepared for an encrypted internet messaging session.",Transport:"TCP provides an ordered byte stream; destination port 443 identifies the secure service.",Network:"Source and destination IP addresses support end-to-end routing across multiple networks.","Data Link":"Each local hop uses source and next-hop MAC addresses; routers rewrite the frame.",Physical:"Bits become wireless, electrical, or optical signals across each medium."};for(const layer of layers){layers.forEach(x=>x.classList.remove("active"));layer.classList.add("active");$("#messageExplanation").textContent=explanations[layer.dataset.layer];await sleep(620)}await animateMessagePath();for(const layer of layers.slice().reverse()){layers.forEach(x=>x.classList.remove("active"));layer.classList.add("active");$("#messageExplanation").textContent=`Receiver decapsulates ${layer.dataset.layer} information and passes the remaining data upward.`;await sleep(370)}layers.forEach(x=>x.classList.remove("active"));$("#receiverChat").querySelector(".chat-placeholder")?.remove();$("#receiverChat").insertAdjacentHTML("beforeend",`<div class="bubble received">${escapeHtml(payload)}<small>delivered ✓✓</small></div>`);const sent=$("#senderChat .bubble:last-child small");sent.textContent="delivered ✓✓";$("#messageExplanation").textContent="Delivery complete. IP addresses stayed end-to-end; MAC addresses changed at routed hops. The application received the original message.";recordHistory("messaging",`Message delivered (${payload.length} characters)`,{transport:"TCP",port:443});messagingBusy=false};
function animateMessagePath(){return new Promise(resolve=>{const path=$("#messagePath"),len=path.getTotalLength(),g=createSvg("g");g.setAttribute("class","message-packet");g.append(createSvg("circle",{r:8}));$("#messagePacket").innerHTML="";$("#messagePacket").append(g);const start=performance.now();function frame(now){const p=Math.min(1,(now-start)/2600),point=path.getPointAtLength(p*len);g.setAttribute("transform",`translate(${point.x} ${point.y})`);if(p<1)requestAnimationFrame(frame);else{g.remove();resolve()}}requestAnimationFrame(frame)})}

// ---------------- TCP / UDP ----------------
$("#servicePort").onchange=e=>{if(e.target.value!=="custom")$("#transportPort").value=e.target.value};
$("#runTransport").onclick=async()=>{const protocol=$("#transportProtocol").value,port=Number($("#transportPort").value),payload=$("#transportPayload").value;const box=$("#sequenceEvents");box.innerHTML="";const events=protocol==="TCP"?[
  {label:"SYN · SEQ 1000",note:"Client requests a connection",reverse:false},{label:"SYN-ACK · SEQ 7000 ACK 1001",note:"Server acknowledges and synchronizes",reverse:true},{label:"ACK · ACK 7001",note:"Three-way handshake complete",reverse:false},{label:`DATA · SEQ 1001 · ${payload.length} bytes`,note:`Application payload to port ${port}`,reverse:false},{label:`ACK · ${1001+payload.length}`,note:"Cumulative acknowledgment",reverse:true},{label:"FIN / ACK",note:"Orderly connection close",reverse:false}
]:[{label:`UDP DATAGRAM · ${payload.length} bytes`,note:`Independent datagram to port ${port}`,reverse:false,udp:true},{label:"No transport acknowledgment",note:"Application may add its own reliability if needed",reverse:true,udp:true}];
  const metrics=$("#protocolMetrics");metrics.innerHTML=protocol==="TCP"?`<div><span>State</span><strong>Connecting</strong></div><div><span>Overhead</span><strong>20+ byte header</strong></div><div><span>Reliability</span><strong>Ordered + ACK</strong></div>`:`<div><span>State</span><strong>Connectionless</strong></div><div><span>Overhead</span><strong>8 byte header</strong></div><div><span>Reliability</span><strong>Best effort</strong></div>`;
  for(let i=0;i<events.length;i++){const ev=events[i],el=document.createElement("div");el.className=`sequence-event ${ev.reverse?"reverse":""} ${ev.udp?"udp":""}`;el.style.top=`${115+i*62}px`;el.innerHTML=`<div class="arrow-line"></div><b>${escapeHtml(ev.label)}</b><small>${escapeHtml(ev.note)}</small>`;box.append(el);await sleep(550)}
  $("#transportExplanation").textContent=protocol==="TCP"?`TCP established state before sending “${payload}”. Sequence numbers track bytes, ACKs confirm the next byte expected, and retransmission can recover loss.`:`UDP sent “${payload}” immediately as one datagram. It avoids handshake and acknowledgment overhead but does not guarantee arrival, ordering, or duplicate protection.`;
  metrics.querySelector("strong").textContent=protocol==="TCP"?"Established → closed":"Datagram sent";recordHistory("transport",`${protocol} simulation to destination port ${port}`,{payloadLength:payload.length})};

// ---------------- Subnet ----------------
$("#calculateSubnet").onclick=calculateSubnet;$("#subnetInput").addEventListener("keydown",e=>{if(e.key==="Enter")calculateSubnet()});
async function calculateSubnet(){try{const r=await api("/api/subnet",{method:"POST",body:{network:$("#subnetInput").value}});const bits=Array.from({length:32},(_,i)=>`<span class="bit ${i<r.prefix?"network":"host"}">${r.binary_mask.replaceAll(".","")[i]}</span>`);$("#subnetVisual").innerHTML=[0,8,16,24].map(s=>`<div class="bit-octet">${bits.slice(s,s+8).join("")}</div>`).join("");const items=[["Network address",r.network],["Broadcast address",r.broadcast],["Subnet mask",r.netmask],["Wildcard mask",r.wildcard],["Usable range",`${r.first_host} – ${r.last_host}`],["Usable hosts",r.usable],["Suggested gateway",r.suggested_gateway],["CIDR prefix",`/${r.prefix}`],["Historical class",`Class ${r.historical_class}`],["Address scope",r.scope],["Total addresses",r.total],["Binary mask",r.binary_mask]];$("#subnetResults").innerHTML=items.map(([k,v])=>`<div class="result-item"><span>${k}</span><strong>${v}</strong></div>`).join("");recordHistory("subnet",`Calculated ${r.input}`,{network:r.network,broadcast:r.broadcast,usable:r.usable})}catch(e){toast(e.message,"error")}}

// ---------------- DHCP ----------------
async function loadLeases(){try{const {leases}=await api("/api/dhcp/leases");$("#leaseTable").innerHTML=`<table><thead><tr><th>Client</th><th>IPv4 lease</th><th>Network</th><th>Duration</th><th>Assigned</th></tr></thead><tbody>${leases.map(l=>`<tr><td>${escapeHtml(l.client_id)}</td><td>${l.ip_address}</td><td>${l.network}</td><td>${formatDuration(l.lease_seconds)}</td><td>${new Date(l.assigned_at).toLocaleString()}</td></tr>`).join("")||`<tr><td colspan="5">No leases yet.</td></tr>`}</tbody></table>`}catch(e){$("#leaseTable").innerHTML=`<div class="empty-state">${escapeHtml(e.message)}</div>`}}
$("#refreshLeases").onclick=loadLeases;
$("#runDhcp").onclick=async()=>{const lane=$("#doraLane");lane.innerHTML="";const steps=[{name:"DISCOVER",text:"0.0.0.0:68 → 255.255.255.255:67",reverse:false},{name:"OFFER",text:"Server proposes an available address",reverse:true},{name:"REQUEST",text:"Client broadcasts its selected offer",reverse:false},{name:"ACKNOWLEDGMENT",text:"Server commits lease and options",reverse:true}];for(let i=0;i<steps.length;i++){const s=steps[i],el=document.createElement("div");el.className=`dora-event ${s.reverse?"reverse":""}`;el.style.top=`${40+i*55}px`;el.innerHTML=`<div class="line"></div><b>${s.name}</b><small>${s.text}</small>`;lane.append(el);await sleep(650)}try{const result=await api("/api/dhcp/leases",{method:"POST",body:{client_id:$("#dhcpClient").value,network:$("#dhcpNetwork").value,lease_seconds:Number($("#leaseDuration").value)}});lane.insertAdjacentHTML("beforeend",`<div class="explanation-box" style="position:absolute;bottom:0;left:10%;right:10%;text-align:center">Lease active: <b>${result.ip_address}</b> for ${formatDuration(result.lease_seconds)}</div>`);toast(`DHCP assigned ${result.ip_address}.`);loadLeases();recordHistory("dhcp",`Lease ${result.ip_address} assigned to ${result.client_id}`,result)}catch(e){toast(e.message,"error")}};
function formatDuration(s){if(s%86400===0)return`${s/86400} day`;if(s%3600===0)return`${s/3600} hour${s===3600?"":"s"}`;return`${s} seconds`}

// ---------------- DNS ----------------
$("#dnsType").onchange=e=>{if(e.target.value==="PTR"&&!/^\d/.test($("#dnsQuery").value))$("#dnsQuery").value="8.8.8.8";if(e.target.value!=="PTR"&&/^\d+\.\d/.test($("#dnsQuery").value))$("#dnsQuery").value="example.com"};
$("#runDns").onclick=async()=>{const hops=$$(".dns-hop");hops.forEach(h=>h.classList.remove("active"));for(const h of hops){h.classList.add("active");await sleep(280)}try{const r=await api("/api/dns",{method:"POST",body:{query:$("#dnsQuery").value,type:$("#dnsType").value}});$("#dnsResults").innerHTML=`<p class="eyebrow">${r.type} ANSWER VIA ${r.resolver.toUpperCase()}</p><div class="answer-list">${r.answers.map(a=>`<span class="dns-answer">${escapeHtml(a)}</span>`).join("")||`<span class="muted">No records returned.</span>`}</div><div class="process-notes"><b>What happened:</b> The browser sent the request to this Python application. Python used the operating system's configured resolver. Cached data may satisfy the request; otherwise the resolver can perform recursive DNS work. NetViz displays the final system-resolver answer rather than generating a simulated IP address.</div>`;recordHistory("dns",`${r.type} lookup for ${r.query}`,{answers:r.answers})}catch(e){$("#dnsResults").innerHTML=`<div class="event-card error"><b>Resolution failed</b><span>${escapeHtml(e.message)}</span></div>`}};

// ---------------- Media ----------------
const mediaData={
  CAT5:{kind:"cable",bandwidth:"100 Mb/s typical",distance:"100 m Ethernet",medium:"Copper twisted pair",desc:"Older four-pair copper cabling. It demonstrates balanced signalling and crosstalk control but is largely superseded for new installations.",uses:["Legacy Ethernet","Telephony"]},
  CAT5e:{kind:"cable",bandwidth:"1 Gb/s typical",distance:"100 m",medium:"Enhanced twisted pair",desc:"Improved crosstalk limits make Category 5e a common and economical choice for Gigabit Ethernet access links.",uses:["Office access","IP cameras","VoIP"]},
  CAT6:{kind:"cable",bandwidth:"1 Gb/s at 100 m; 10 Gb/s shorter",distance:"100 m / ~55 m at 10G",medium:"Tighter twisted pair",desc:"Higher performance copper with improved separation and noise resistance. Installation quality still matters.",uses:["Campus LAN","Access switches","PoE"]},
  CAT6a:{kind:"cable",bandwidth:"10 Gb/s",distance:"100 m",medium:"Augmented twisted pair",desc:"Designed for full-distance 10 Gigabit Ethernet with stronger alien-crosstalk control and typically larger cable diameter.",uses:["10G access","Data centre edge","Wi-Fi 6/7 uplinks"]},
  Coaxial:{kind:"cable",bandwidth:"Technology dependent",distance:"Longer RF runs",medium:"Shielded central conductor",desc:"A central conductor and concentric shield carry radio-frequency signals with strong noise immunity.",uses:["Cable broadband","CCTV","RF distribution"]},
  Fibre:{kind:"cable",bandwidth:"Multi-gigabit to terabit",distance:"Hundreds of metres to kilometres",medium:"Light through glass",desc:"Optical fibre offers high bandwidth, low attenuation, electrical isolation, and immunity to electromagnetic interference.",uses:["Backbones","WAN","Data centres","FTTH"]},
  "Wi-Fi":{kind:"wireless",bandwidth:"Varies by 802.11 generation",distance:"Room / building scale",medium:"Radio in unlicensed bands",desc:"Shared radio cells use contention, association, authentication, channels, and variable modulation based on signal quality.",uses:["Wireless LAN","Mobile clients","IoT"]},
  Bluetooth:{kind:"wireless",bandwidth:"Low to moderate",distance:"Personal area",medium:"2.4 GHz radio",desc:"Short-range personal-area technology optimized for peripherals, audio, and low-energy sensors.",uses:["Headsets","Keyboards","BLE sensors"]},
  Cellular:{kind:"wireless",bandwidth:"Varies with 4G/5G radio",distance:"Wide-area cells",medium:"Licensed radio spectrum",desc:"Operator-managed radio access provides mobility, registration, scheduled resources, handover, and wide-area service.",uses:["Mobile broadband","Voice","Connected vehicles"]},
  Infrared:{kind:"wireless",bandwidth:"Device dependent",distance:"Short line-of-sight",medium:"Infrared light",desc:"Directional light-based communication avoids RF interference but usually requires alignment and unobstructed paths.",uses:["Remote controls","Point-to-point sensors"]}
};
function renderMedia(name){const d=mediaData[name];$("#mediaAnimation").innerHTML=d.kind==="cable"?`<div class="cable-demo"><div class="signal-pulse"></div></div>`:`<div class="wireless-demo"><div class="wireless-source"></div><div class="wave"></div><div class="wave"></div><div class="wave"></div></div>`;$("#mediaDetails").innerHTML=`<p class="eyebrow">${d.kind.toUpperCase()} TECHNOLOGY</p><h2>${name}</h2><p>${d.desc}</p><div class="spec-list"><div><span>Bandwidth</span><b>${d.bandwidth}</b></div><div><span>Practical reach</span><b>${d.distance}</b></div><div><span>Signal medium</span><b>${d.medium}</b></div></div><h4>Typical applications</h4>${d.uses.map(u=>`<span class="use-pill">${u}</span>`).join("")}`}
$$("#mediaTabs button").forEach(b=>b.onclick=()=>{$$("#mediaTabs button").forEach(x=>x.classList.toggle("active",x===b));renderMedia(b.dataset.media)});

// ---------------- Quiz ----------------
const quizState={level:"beginner",questions:[]};
async function loadQuiz(level){try{quizState.level=level;const result=await api(`/api/quiz/${level}`);quizState.questions=result.questions;$("#quizForm").innerHTML=result.questions.map((q,i)=>`<article class="quiz-question"><p class="eyebrow">${q.topic}</p><h3>${i+1}. ${escapeHtml(q.q)}</h3>${q.options.map((o,j)=>`<label class="option"><input type="radio" name="q${i}" value="${j}">${escapeHtml(o)}</label>`).join("")}</article>`).join("")+`<div class="quiz-actions"><button class="primary" type="submit">Submit answers</button></div>`;$("#quizResult").innerHTML=""}catch(e){toast(e.message,"error")}}
$$(".quiz-levels button").forEach(b=>b.onclick=()=>{$$(".quiz-levels button").forEach(x=>x.classList.toggle("active",x===b));loadQuiz(b.dataset.level)});
$("#quizForm").onsubmit=async e=>{e.preventDefault();const answers=quizState.questions.map((_,i)=>{const x=$(`[name="q${i}"]:checked`);return x?Number(x.value):null});try{const r=await api(`/api/quiz/${quizState.level}/submit`,{method:"POST",body:{answers}});$("#quizResult").innerHTML=`<div class="quiz-summary glass"><div class="score-ring">${r.score}/${r.total}</div><h3 style="text-align:center">${r.score===r.total?"Excellent—full marks!":"Review and retry"}</h3><p class="muted" style="text-align:center">${r.revision_topics.length?`Revision focus: ${r.revision_topics.join(", ")}`:"No weak topics identified."}</p>${r.results.map((x,i)=>`<div class="review-item ${x.correct?"correct":""}"><b>Question ${i+1} · ${x.correct?"Correct":"Needs review"}</b><br>${escapeHtml(x.explanation)}</div>`).join("")}</div>`;recordHistory("quiz",`${quizState.level} quiz: ${r.score}/${r.total}`,{revision:r.revision_topics})}catch(err){toast(err.message,"error")}};

// ---------------- History ----------------
async function loadHistory(){try{const [s,q]=await Promise.all([api("/api/history"),api("/api/quiz-history")]);$("#simulationHistory").innerHTML=s.history.map(x=>`<div class="history-item"><span class="type">${escapeHtml(x.simulation_type.slice(0,3).toUpperCase())}</span><div><strong>${escapeHtml(x.summary)}</strong><small>${escapeHtml(x.simulation_type)} experiment</small></div><time>${new Date(x.created_at).toLocaleString()}</time></div>`).join("")||`<div class="empty-state">Run a lab to create history.</div>`;$("#quizHistory").innerHTML=q.history.map(x=>`<div class="history-item"><span class="type">${x.score}/${x.total}</span><div><strong>${capitalize(x.difficulty)} quiz</strong><small>${x.weak_topics.length?`Review: ${x.weak_topics.join(", ")}`:"All topics correct"}</small></div><time>${new Date(x.created_at).toLocaleDateString()}</time></div>`).join("")||`<div class="empty-state">Complete a quiz to see results.</div>`}catch(e){toast(e.message,"error")}}
if ($("#refreshHistory")) $("#refreshHistory").onclick=loadHistory;

function escapeHtml(value){const d=document.createElement("div");d.textContent=String(value);return d.innerHTML}
function escapeAttr(value){return escapeHtml(value).replaceAll('"','&quot;')}
function capitalize(v){return v.charAt(0).toUpperCase()+v.slice(1)}

async function initDeploymentStatus(){
  try{
    const info=await api("/api/deployment");
    if(info.serverless){
      const badge=$(".simulation-badge");
      badge.classList.add("serverless-badge");
      badge.innerHTML="<i></i>";
      badge.title=info.message;
    }
  }catch(_){/* The lab remains usable if deployment metadata is unavailable. */}
}

// Boot
initPalette(); renderTopology(); renderInspector(); initMobileDrag(); renderMedia("CAT5"); initAuth(); initDeploymentStatus(); calculateSubnet();
