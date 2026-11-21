import unittest
from network_engine import simulate_packet

class NetworkEngineTests(unittest.TestCase):
    def setUp(self):
        self.nodes = [
            {"id":1,"type":"PC","ip":"192.168.10.10","mask":"255.255.255.0","vlan":10,"mac":"02:00:00:00:00:10"},
            {"id":2,"type":"Switch","switchPorts":{"1":{"name":"Gi0/1","mode":"access","vlan":10},"3":{"name":"Gi0/2","mode":"access","vlan":10}}},
            {"id":3,"type":"PC","ip":"192.168.10.20","mask":"255.255.255.0","vlan":10,"mac":"02:00:00:00:00:20"}
        ]
        self.links = [{"a":1,"b":2,"mode":"access","vlan":10},{"a":2,"b":3,"mode":"access","vlan":10}]
    def test_same_vlan_delivery(self):
        self.assertTrue(simulate_packet({"nodes":self.nodes,"links":self.links,"source":1,"destination":3})["ok"])

    def test_extended_acl_matches_protocol_and_port(self):
        rule={"action":"DENY","src":"192.168.10.0/24","dst":"192.168.10.0/24","protocol":"TCP","destination_port":22}
        denied=simulate_packet({"nodes":self.nodes,"links":self.links,"source":1,"destination":3,"acls":[rule],"protocol":"TCP","destination_port":22})
        allowed=simulate_packet({"nodes":self.nodes,"links":self.links,"source":1,"destination":3,"acls":[rule],"protocol":"UDP","destination_port":53})
        self.assertFalse(denied["ok"])
        self.assertTrue(allowed["ok"])
    def test_acl_deny(self):
        r=simulate_packet({"nodes":self.nodes,"links":self.links,"source":1,"destination":3,"acls":[{"action":"DENY","src":"192.168.10.0/24","dst":"192.168.10.0/24"}]})
        self.assertFalse(r["ok"])
    def test_trunk_blocks_disallowed_vlan(self):
        links=[dict(self.links[0],mode="trunk",allowed=[20]),self.links[1]]
        self.assertFalse(simulate_packet({"nodes":self.nodes,"links":links,"source":1,"destination":3})["ok"])
    def test_subnet_isolation_without_router(self):
        n=[dict(self.nodes[0]),dict(self.nodes[2],id=4,ip="192.168.20.20")]
        self.assertFalse(simulate_packet({"nodes":n,"links":[{"a":1,"b":4,"mode":"access","vlan":10}],"source":1,"destination":4})["ok"])


    def test_port_security_sticky_learns_first_mac(self):
        self.nodes[1]["switchPorts"]["1"]["port_security"] = True
        result=simulate_packet({"nodes":self.nodes,"links":self.links,"source":1,"destination":3})
        self.assertTrue(result["ok"])
        self.assertEqual(result["port_security_learned"][0]["mac"], "02:00:00:00:00:10")
    def test_switch_port_security_violation(self):
        self.nodes[1]["switchPorts"]["1"]["port_security"] = True
        self.nodes[1]["switchPorts"]["1"]["secure_mac"] = "02:00:00:00:00:99"
        result=simulate_packet({"nodes":self.nodes,"links":self.links,"source":1,"destination":3})
        self.assertFalse(result["ok"])


    def test_stp_blocks_redundant_switch_loop_link(self):
        n=[
            {"id":1,"type":"PC","ip":"192.168.1.10","mask":"255.255.255.0","vlan":1},
            {"id":2,"type":"Switch","name":"SW1"},
            {"id":3,"type":"Switch","name":"SW2"},
            {"id":4,"type":"Switch","name":"SW3"},
            {"id":5,"type":"PC","ip":"192.168.1.20","mask":"255.255.255.0","vlan":1}
        ]
        l=[{"a":1,"b":2,"mode":"access","vlan":1},{"a":2,"b":3,"mode":"trunk","allowed":[1]},{"a":3,"b":4,"mode":"trunk","allowed":[1]},{"a":4,"b":2,"mode":"trunk","allowed":[1]},{"a":4,"b":5,"mode":"access","vlan":1}]
        result=simulate_packet({"nodes":n,"links":l,"source":1,"destination":5})
        self.assertTrue(result["ok"])
        self.assertTrue(any(x["state"]=="BLOCKING" for x in result["stp_table"]))
    def test_static_route_is_used_for_remote_destination(self):
        n=[
            {"id":1,"type":"PC","ip":"192.168.10.10","mask":"255.255.255.0","gateway":"192.168.10.1","vlan":10},
            {"id":2,"type":"Router","interfaces":[{"name":"G0/0","ip":"192.168.10.1","mask":"255.255.255.0"}],"routes":[{"network":"192.168.30.0/24","next_hop":"10.0.0.2","interface":"G0/1"}]},
            {"id":3,"type":"PC","ip":"192.168.30.20","mask":"255.255.255.0","gateway":"192.168.30.1","vlan":30}
        ]
        l=[{"a":1,"b":2,"mode":"access","vlan":10},{"a":2,"b":3,"mode":"access","vlan":30}]
        self.assertTrue(simulate_packet({"nodes":n,"links":l,"source":1,"destination":3})["ok"])
    def test_inter_vlan_routing(self):
        n=[
            {"id":1,"type":"PC","ip":"192.168.10.10","mask":"255.255.255.0","gateway":"192.168.10.1","vlan":10,"mac":"02:00:00:00:00:10"},
            {"id":2,"type":"Switch","switchPorts":{"1":{"name":"Gi0/1","mode":"access","vlan":10},"3":{"name":"Gi0/2","mode":"trunk","allowed":[10,20]}}},
            {"id":3,"type":"Router","interfaces":[{"name":"G0/0.10","vlan":10,"ip":"192.168.10.1","mask":"255.255.255.0"},{"name":"G0/0.20","vlan":20,"ip":"192.168.20.1","mask":"255.255.255.0"}]},
            {"id":4,"type":"Switch","switchPorts":{"3":{"name":"Gi0/1","mode":"trunk","allowed":[10,20]},"5":{"name":"Gi0/2","mode":"access","vlan":20}}},
            {"id":5,"type":"PC","ip":"192.168.20.20","mask":"255.255.255.0","gateway":"192.168.20.1","vlan":20,"mac":"02:00:00:00:00:20"}
        ]
        l=[{"a":1,"b":2,"mode":"access","vlan":10},{"a":2,"b":3,"mode":"trunk","allowed":[10,20]},{"a":3,"b":4,"mode":"trunk","allowed":[10,20]},{"a":4,"b":5,"mode":"access","vlan":20}]
        self.assertTrue(simulate_packet({"nodes":n,"links":l,"source":1,"destination":5})["ok"])

if __name__ == "__main__":
    unittest.main()
