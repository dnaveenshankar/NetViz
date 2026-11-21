"""Deterministic educational Layer 2/Layer 3 packet simulation engine."""
from __future__ import annotations
import ipaddress
from collections import deque, defaultdict

def _net(ip, mask):
    return ipaddress.ip_network(f"{ip}/{mask}", strict=False)

def _cidr_match(value, address):
    try:
        return ipaddress.ip_address(address) in ipaddress.ip_network(value, strict=False)
    except Exception:
        return False

def simulate_packet(data):
    nodes = data.get("nodes", [])
    links = data.get("links", [])
    acls = data.get("acls", [])
    src_id, dst_id = data.get("source"), data.get("destination")
    src = next((n for n in nodes if str(n.get("id")) == str(src_id)), None)
    dst = next((n for n in nodes if str(n.get("id")) == str(dst_id)), None)
    if not src or not dst:
        return {"ok": False, "reason": "Select valid source and destination devices.", "events": []}
    events = []
    for rule in acls:
        try:
            ipaddress.ip_network(rule.get("src", "0.0.0.0/0"), strict=False)
            ipaddress.ip_network(rule.get("dst", "0.0.0.0/0"), strict=False)
            if rule.get("destination_port") and not (1 <= int(rule["destination_port"]) <= 65535):
                raise ValueError("ACL destination port must be 1–65535")
        except Exception as exc:
            return {"ok": False, "reason": f"Invalid ACL rule: {exc}", "events": events}
    port_security_learned = []
    def event(layer, title, detail, state="info"):
        events.append({"layer": layer, "title": title, "detail": detail, "state": state})
    if not src.get("ip") or not dst.get("ip"):
        return {"ok": False, "reason": "Both endpoints need an IPv4 address. Configure static addressing or run DHCP first.", "events": events}
    try:
        sn = _net(src["ip"], src.get("mask", "255.255.255.0"))
        dn = _net(dst["ip"], dst.get("mask", "255.255.255.0"))
    except Exception as exc:
        return {"ok": False, "reason": f"Invalid endpoint addressing: {exc}", "events": events}
    # Simplified IEEE 802.1D spanning-tree teaching model: choose a deterministic
    # spanning forest for switch-to-switch links and block redundant loop edges.
    switch_ids = {str(n.get("id")) for n in nodes if str(n.get("type", "")).lower() == "switch"}
    parent_stp = {sid: sid for sid in switch_ids}
    def find_stp(x):
        while parent_stp[x] != x:
            parent_stp[x] = parent_stp[parent_stp[x]]
            x = parent_stp[x]
        return x
    switch_edges = []
    for li, link in enumerate(links):
        x, y = str(link.get("a")), str(link.get("b"))
        if x in switch_ids and y in switch_ids:
            switch_edges.append((li, x, y))
    blocked_links = set()
    for li, x, y in switch_edges:
        rx, ry = find_stp(x), find_stp(y)
        if rx == ry:
            blocked_links.add(li)
        else:
            parent_stp[ry] = rx
    stp_table = [{"link": i+1, "state": "BLOCKING" if i in blocked_links else "FORWARDING"} for i, _, _ in switch_edges]
    if switch_edges:
        event("L2", "Spanning Tree Protocol", f"STP loop check: {len(blocked_links)} redundant switch link(s) placed in blocking state; {len(switch_edges)-len(blocked_links)} forwarding.", "pass")
    graph = defaultdict(list)
    for li, link in enumerate(links):
        if li in blocked_links:
            continue
        x, y = str(link.get("a")), str(link.get("b"))
        if any(str(n.get("id")) == x for n in nodes) and any(str(n.get("id")) == y for n in nodes):
            graph[x].append((y, link)); graph[y].append((x, link))
    q, seen, parent = deque([str(src_id)]), {str(src_id)}, {}
    while q:
        cur = q.popleft()
        if cur == str(dst_id): break
        for nxt, link in graph[cur]:
            if nxt not in seen:
                seen.add(nxt); parent[nxt] = (cur, link); q.append(nxt)
    if str(dst_id) not in seen:
        event("L1", "No physical path", "No cable or wireless association connects the endpoints.", "drop")
        return {"ok": False, "reason": "No physical path exists between the selected devices.", "events": events}
    path_ids, path_links, cur = [str(dst_id)], [], str(dst_id)
    while cur != str(src_id):
        prev, link = parent[cur]; path_links.append(link); path_ids.append(prev); cur = prev
    path_ids.reverse(); path_links.reverse()
    path = [next(n for n in nodes if str(n.get("id")) == pid) for pid in path_ids]
    path_names = [n.get("name") or n.get("type", "device") for n in path]
    vlan_src, vlan_dst = int(src.get("vlan", 1)), int(dst.get("vlan", 1))
    event("L1", "Physical path discovered", " → ".join(path_names), "pass")
    # VLAN continuity: access links carry one VLAN; trunks carry explicitly allowed VLANs.
    vlan = vlan_src
    for idx, link in enumerate(path_links):
        # A router rewrites the Layer-2 frame and may emit it into a different VLAN.
        if str(path[idx].get("type", "")).lower() in ("router", "l3 switch", "layer 3 switch"):
            vlan = vlan_dst
        mode = link.get("mode", "access")
        access_vlan = int(link.get("vlan", link.get("accessVlan", vlan)))
        allowed = [int(v) for v in link.get("allowed", [access_vlan])]
        if mode == "access":
            if access_vlan != vlan:
                event("L2", "Access VLAN mismatch", f"Link {idx+1} is access VLAN {access_vlan}; packet is in VLAN {vlan}.", "drop")
                return {"ok": False, "reason": "VLAN mismatch on access link. Frames cannot cross this VLAN boundary.", "path": path_names, "events": events}
        else:
            if vlan not in allowed:
                event("L2", "802.1Q trunk filter", f"VLAN {vlan} is not in allowed VLAN list {allowed}.", "drop")
                return {"ok": False, "reason": f"Trunk does not allow VLAN {vlan}.", "path": path_names, "events": events}
            event("L2", "802.1Q tag added", f"Trunk carries VLAN {vlan}; allowed VLANs: {allowed}.", "pass")
    # Enforce configured switch access/trunk membership on ingress and egress ports.
    for idx, device in enumerate(path):
        if str(device.get("type", "")).lower() != "switch":
            continue
        port_map = device.get("switchPorts", {}) or {}
        if idx > 0 and str(path[idx-1].get("type", "")).lower() in ("router", "l3 switch", "layer 3 switch"):
            vlan = vlan_dst
        prev_id = str(path[idx-1].get("id")) if idx > 0 else None
        next_id = str(path[idx+1].get("id")) if idx+1 < len(path) else None
        for direction, neighbor_id in (("ingress", prev_id), ("egress", next_id)):
            cfg = port_map.get(neighbor_id) if neighbor_id else None
            if not cfg:
                continue
            pmode = cfg.get("mode", "access")
            connected = next((n for n in nodes if str(n.get("id")) == neighbor_id), None)
            secure_mac = str(cfg.get("secure_mac", "")).upper()
            if cfg.get("port_security") and connected:
                received_mac = str(connected.get("mac", "")).upper()
                if secure_mac and received_mac != secure_mac:
                    event("L2", "Port-security violation", f"Port {cfg.get('name')} expected secure MAC {secure_mac}; received {received_mac or 'unknown'}.", "drop")
                    return {"ok": False, "reason": "Switch port security rejected an unrecognized source MAC address.", "path": path_names, "events": events}
                if not secure_mac and received_mac:
                    cfg["secure_mac"] = received_mac
                    port_security_learned.append({"switch_id": device.get("id"), "neighbor_id": neighbor_id, "mac": received_mac, "port": cfg.get("name")})
                    event("L2", "Sticky MAC learned", f"Port {cfg.get('name')} learned {received_mac}; subsequent different MACs will be blocked.", "pass")
            p_vlan = int(cfg.get("vlan", vlan))
            p_allowed = [int(v) for v in cfg.get("allowed", [])]
            if pmode == "access":
                if direction == "ingress":
                    vlan = p_vlan
                    event("L2", "Access-port classification", f"{cfg.get('name', 'port')} assigns untagged ingress traffic to VLAN {vlan}.", "pass")
                elif p_vlan != vlan:
                    event("L2", "Access-port VLAN mismatch", f"Egress port {cfg.get('name')} belongs to VLAN {p_vlan}, but frame is in VLAN {vlan}.", "drop")
                    return {"ok": False, "reason": "Switch access port VLAN does not match the frame VLAN.", "path": path_names, "events": events}
            elif vlan not in p_allowed:
                event("L2", "Trunk VLAN filter", f"Port {cfg.get('name')} does not allow VLAN {vlan}; allowed: {p_allowed}.", "drop")
                return {"ok": False, "reason": f"Switch trunk port {cfg.get('name')} blocks VLAN {vlan}.", "path": path_names, "events": events}
            else:
                event("L2", "802.1Q switch trunk", f"Port {cfg.get('name')} carries VLAN {vlan} with an 802.1Q tag.", "pass")
    # ACLs are evaluated in order, first matching rule wins.
    proto = str(data.get("protocol", "TCP")).upper()
    dst_port = int(data.get("destination_port", 443) or 443)
    for rule in acls:
        protocol_match = rule.get("protocol", "ANY").upper() in ("ANY", proto)
        port_match = not rule.get("destination_port") or int(rule.get("destination_port")) == dst_port
        if protocol_match and port_match and _cidr_match(rule.get("src", "0.0.0.0/0"), src["ip"]) and _cidr_match(rule.get("dst", "0.0.0.0/0"), dst["ip"]):
            action = rule.get("action", "DENY").upper()
            event("L3", f"ACL {action}", f"First matching rule: {rule.get('src')} → {rule.get('dst')}.", "pass" if action == "PERMIT" else "drop")
            if action != "PERMIT":
                return {"ok": False, "reason": "Packet denied by the first matching ACL rule.", "path": path_names, "events": events}
            break
    same_subnet = sn == dn
    routers = [n for n in path if str(n.get("type", "")).lower() in ("router", "l3 switch", "layer 3 switch")]
    if same_subnet and vlan_src == vlan_dst:
        event("L2", "Switching decision", "Source and destination are in the same subnet and VLAN. Switches forward by destination MAC.", "pass")
        next_hop = dst
    else:
        if not routers:
            event("L3", "No route", f"{src['ip']} and {dst['ip']} are in different IP networks; no router is on the path.", "drop")
            return {"ok": False, "reason": "Different subnets require a router with a matching route and gateway.", "path": path_names, "events": events}
        router = routers[0]
        interfaces = router.get("interfaces", [])
        src_gw = src.get("gateway")
        dst_gw = dst.get("gateway")
        connected_nets = [_net(i.get("ip"), i.get("mask", "255.255.255.0")) for i in interfaces if i.get("ip")]
        static_routes = router.get("routes", []) or []
        destination_routes = []
        for route in static_routes:
            try:
                net = ipaddress.ip_network(route.get("network", ""), strict=False)
                if ipaddress.ip_address(dst["ip"]) in net:
                    destination_routes.append((net.prefixlen, route))
            except Exception:
                continue
        has_source = any(ipaddress.ip_address(src["ip"]) in net for net in connected_nets)
        connected_destination = any(ipaddress.ip_address(dst["ip"]) in net for net in connected_nets)
        best_static_route = max(destination_routes, key=lambda item: item[0])[1] if destination_routes else None
        has_destination = connected_destination or best_static_route is not None
        routed = has_source and has_destination
        if not routed:
            event("L3", "Route lookup failed", "Router needs an interface or connected route for both source and destination networks.", "drop")
            return {"ok": False, "reason": "Router has no connected interfaces/routes for both subnets. Configure router interfaces.", "path": path_names, "events": events}
        chosen = "connected route" if connected_destination else f"static route {best_static_route.get('network')} via {best_static_route.get('next_hop')}"
        event("L3", "Longest-prefix route lookup", f"Router {router.get('name') or router['id']} selects {chosen} for destination {dst['ip']}.", "pass")
        event("L2", "Layer 2 rewrite", "Router removes the incoming frame header and builds a new frame for the outgoing interface.", "pass")
        next_hop = router
    # ARP resolution and switch MAC learning/forwarding explanation.
    if next_hop is dst:
        arp_target = dst["ip"]
    else:
        matching_if = next((it for it in next_hop.get("interfaces", []) if it.get("ip") and ipaddress.ip_address(src["ip"]) in _net(it["ip"], it.get("mask", "255.255.255.0"))), None)
        arp_target = src.get("gateway") or (matching_if.get("ip") if matching_if else next_hop.get("ip", "gateway"))
    arp_mac = next_hop.get("mac", "02:00:00:00:00:FE")
    event("L2", "ARP request / reply", f"Who has {arp_target}? Reply: {arp_mac}. ARP resolves IPv4 next hop to a local-link MAC.", "pass")
    mac_table, learned = [], []
    for idx, device in enumerate(path):
        if str(device.get("type", "")).lower() == "switch":
            port_map = device.get("switchPorts", {}) or {}
            incoming = (port_map.get(str(path[idx-1].get("id")), {}) or {}).get("name", f"Gi0/{max(1, idx)}") if idx > 0 else "CPU"
            outgoing = (port_map.get(str(path[idx+1].get("id")), {}) or {}).get("name", f"Gi0/{idx+1}") if idx+1 < len(path) else "CPU"
            mac_table.append({"vlan": vlan, "mac": src.get("mac", "unknown"), "port": incoming, "type": "dynamic"})
            mac_table.append({"vlan": vlan, "mac": dst.get("mac", "unknown"), "port": outgoing, "type": "dynamic"})
            learned.append(device.get("name") or f"Switch {device['id']}")
            event("L2", "MAC address-table lookup", f"{device.get('name') or 'Switch'} learns source MAC on {incoming}, then forwards known unicast toward {outgoing}; unknown destinations are flooded only within VLAN {vlan}.", "pass")
    for sw in nodes:
        if str(sw.get("type", "")).lower() == "switch":
            for neighbor_id, cfg in (sw.get("switchPorts", {}) or {}).items():
                if cfg.get("static_mac"):
                    mac_table.append({"vlan": int(cfg.get("vlan", 1)), "mac": str(cfg["static_mac"]).upper(), "port": cfg.get("name", "configured-port"), "type": "static"})
    event("L3", "IP packet forwarding", f"Source {src['ip']} → destination {dst['ip']}; IP addresses remain end-to-end (TTL decreases at each router).", "pass")
    event("L4", "Transport delivery", f"{proto} destination port {dst_port} is delivered to the matching application socket/service.", "pass")
    event("L1", "Frame transmitted", "Bits are encoded onto the configured medium and received by the destination interface.", "pass")
    return {"ok": True, "reason": "Packet delivered by the simulated forwarding path.", "path": path_names, "events": events, "mac_table": mac_table, "arp_table": [{"ip": arp_target, "mac": arp_mac, "interface": "outgoing"}], "route_table": (([{"network": str(_net(it["ip"], it.get("mask", "255.255.255.0"))), "next_hop": "connected", "protocol": "C", "interface": it.get("name", "interface")} for it in routers[0].get("interfaces", []) if it.get("ip")] + [{"network": r.get("network"), "next_hop": r.get("next_hop", "unspecified"), "protocol": "S", "interface": r.get("interface", "")} for r in routers[0].get("routes", [])]) if routers else []), "learned_switches": learned, "stp_table": stp_table, "port_security_learned": port_security_learned}
