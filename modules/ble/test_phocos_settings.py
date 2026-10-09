import asyncio
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location("ble_helper", ROOT / "ble_helper.py")
ble = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ble)

class Char:
    def __init__(self, uuid, props=("read", "write", "write-without-response")):
        self.uuid, self.properties = uuid, props
class Service:
    def __init__(self, chars): self.chars = chars
    def get_characteristic(self, uuid): return self.chars.get(uuid)
class Services:
    def __init__(self, svc): self.svc = svc
    def get_service(self, uuid): return self.svc if uuid == ble.full_uuid("1810") else None
class Client:
    def __init__(self, model=b"TEST000000000000019x", rating=(2300,500,6500,480)):
        self.services = Services(Service({ble.full_uuid(x): Char(ble.full_uuid(x)) for x in ("2a02","2a05","2a0c","2a0d","2a0e")}))
        self.data = {"2a02": bytearray(model), "2a05": bytearray(20), "2a0c": bytearray(20), "2a0d": bytearray(20), "2a0e": bytearray(range(20))}
        for o,v in zip((4,6,12,14),rating): self.data["2a05"][o:o+2]=int(v).to_bytes(2,"little")
        self.data["2a0c"][2:4]=(500).to_bytes(2,"little")
        self.data["2a0c"][4:6]=bytes((50,40))
        self.data["2a0c"][6:10]=(520).to_bytes(2,"little")+(540).to_bytes(2,"little")
        self.data["2a0d"][16:18]=(5).to_bytes(2,"little")
        self.writes=[]; self.fail_readback=False; self.mismatch_readback=False
    async def read_gatt_char(self,ch):
        key=ch.uuid[4:8]
        if self.fail_readback and self.writes and key in ("2a0c","2a0d","2a0e"): raise TimeoutError("readback")
        value=bytearray(self.data[key])
        if self.mismatch_readback and self.writes: value[16:18]=bytes((0,0))
        return bytes(value)
    async def write_gatt_char(self,ch,value,response=False):
        assert response
        self.writes.append((ch.uuid[4:8],bytes(value)))
        self.data[ch.uuid[4:8]]=bytearray(value)
class Link:
    def __init__(self,c): self.client=c

class Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client=Client(rating=(2300,500,5000,480)); ble.KEEP_ALIVE=True
        async def fake(*a): return Link(self.client)
        ble._gatt_link=fake
    async def call(self,args): return await ble.COMMANDS["phocos_gatt_change"]({"address":"AA:BB:CC:DD:EE:FF",**args})
    async def test_identity_model_ratings_and_known_flags(self):
        self.assertEqual(len(self.client.data["2a02"]),20)
        for args in ({"field":"float_voltage","value":31,"expected":52}, {"field":"max_charging_current","value":81,"expected":50}):
            with self.assertRaises(ble.HelperError): await self.call(args)
        self.client.data["2a02"][18]=ord("x")
        with self.assertRaises(ble.HelperError): await self.call({"field":"record_fault_codes","value":True,"expected":False})
    async def test_flag_preserves_high_bits_and_fullblock_unknown(self):
        self.client.data["2a0d"][0:2]=(0x8000).to_bytes(2,"little")
        r=await self.call({"field":"record_fault_codes","value":True,"expected":False})
        self.assertEqual(r["status"],"done"); self.assertEqual(int.from_bytes(self.client.data["2a0d"][:2],"little"),0x8001)
        self.assertEqual(self.client.data["2a0d"][2:16],bytearray(14))
        self.assertEqual(self.client.data["2a0d"][16:],(5).to_bytes(2,"little")+bytes(2))
    async def test_scaled_frequency_write_and_noop(self):
        r=await self.call({"field":"output_frequency","value":60,"expected":50})
        self.assertEqual(r["status"],"done")
        self.assertEqual(int.from_bytes(self.client.data["2a0c"][2:4],"little"),600)
        self.assertEqual(r["readback"],60)
        before=len(self.client.writes)
        r=await self.call({"field":"output_frequency","value":60,"expected":60})
        self.assertEqual(r,{"ok":True,"status":"verified","value":60})
        self.assertEqual(len(self.client.writes),before)

    async def test_scaled_voltage_noop_has_zero_physical_writes(self):
        self.client.data["2a0c"][6:8]=(540).to_bytes(2,"little")
        before=len(self.client.writes)
        r=await self.call({"field":"float_voltage","value":54.0,"expected":54.0})
        self.assertEqual(r,{"ok":True,"status":"verified","value":54.0})
        self.assertEqual(len(self.client.writes),before)

    async def test_numeric_packing_and_noop(self):
        r=await self.call({"field":"boost_duration","value":120,"expected":5})
        self.assertEqual(r["status"],"done"); self.assertEqual(self.client.data["2a0d"][16:18],(120).to_bytes(2,"little"))
        n=len(self.client.writes)
        r=await self.call({"field":"boost_duration","value":120,"expected":120})
        self.assertEqual(r["status"],"verified"); self.assertEqual(len(self.client.writes),n)
    async def test_expected_stale_and_bool_not_numeric(self):
        with self.assertRaises(ble.HelperError): await self.call({"field":"record_fault_codes","value":1,"expected":False})
        r=await self.call({"field":"record_fault_codes","value":True,"expected":True})
        self.assertEqual(r["status"],"refused")
    async def test_current_expected_and_value_are_all_catalogue_validated(self):
        self.client.data["2a0c"][4]=250
        with self.assertRaises(ble.HelperError): await self.call({"field":"max_charging_current","value":40,"expected":250})
        self.assertEqual(self.client.writes,[])
        self.client.data["2a0c"][4]=50
        with self.assertRaises(ble.HelperError): await self.call({"field":"max_charging_current","value":40,"expected":250})
        self.assertEqual(self.client.writes,[])

    async def test_nominal_ac_choices_are_independent_of_battery_voltage(self):
        spec24=ble.catalogue("9",24,3000,230)
        spec48=ble.catalogue("9",48,5000,120)
        self.assertEqual(spec24["output_voltage"]["allowed"],(220,230,240))
        self.assertEqual(spec24["float_voltage"]["max"],40)
        self.assertEqual(spec48["float_voltage"]["max"],64)
        self.assertEqual(spec48["boost_voltage"]["max"],64)
        self.client.data["2a05"][12:14]=(5000).to_bytes(2,"little")
        self.client.data["2a05"][14:16]=(480).to_bytes(2,"little")
        r=await self.call({"field":"boost_voltage","value":64,"expected":54})
        self.assertEqual(r["status"],"done")
        with self.assertRaises(ble.HelperError): await self.call({"field":"boost_voltage","value":65,"expected":64})
        self.assertEqual(spec48["output_voltage"]["allowed"],(110,120,127))
        self.assertEqual(ble.catalogue("9",48,5000,230)["output_voltage"]["allowed"],(220,230,240))
        self.assertEqual(ble.catalogue("1",24,3000,120)["output_voltage"]["allowed"],(110,120,127))
        with self.assertRaises(ValueError): ble.catalogue("1",24,5000,230)

    async def test_realistic_bleak_write_property(self):
        self.client.services.svc.chars[ble.full_uuid("2a0d")].properties=("read","write-without-response")
        with self.assertRaises(ble.HelperError): await self.call({"field":"boost_duration","value":6,"expected":5})
        self.assertEqual(self.client.writes,[])

    async def test_dry_metadata_allowlist(self):
        for f in ("equalization_voltage","byte5_unknown","force_equalization","output_mode","flag10_unknown"):
            with self.assertRaises(ble.HelperError): await self.call({"field":f,"value":True,"expected":False})
    async def test_enum_flags_steps_and_relationship_validation(self):
        for field,value,expected in (("output_priority",3,0),("output_priority",1.5,0),("output_frequency",55,50),("boost_duration",4,5),("boost_duration",901,5),("max_utility_charging_current",51,40),("float_voltage",54.1,52)):
            with self.assertRaises(ble.HelperError,msg=(field,value)): await self.call({"field":field,"value":value,"expected":expected})
        for field,value,expected in (("output_priority",2,0),("output_frequency",60,50),("float_voltage",53,52)):
            r=await self.call({"field":field,"value":value,"expected":expected})
            self.assertEqual(r["status"],"done",(field,r))
    async def test_unknown_preservation_optional_characteristic_and_dispatch_outcomes(self):
        raw=self.client.data["2a0d"]; raw[4:16]=bytes(range(4,16))
        await self.call({"field":"boost_duration","value":6,"expected":5})
        self.assertEqual(self.client.data["2a0d"][18:],bytes(2))
        self.client.services.svc.chars.pop(ble.full_uuid("2a0e"))
        r=await self.call({"field":"discharge_current","value":0,"expected":0})
        self.assertEqual(r["status"],"refused")
        self.client.writes.clear(); self.client.fail_readback=True
        r=await self.call({"field":"boost_duration","value":7,"expected":6})
        self.assertEqual(r["status"],"sent_unverified")
    async def test_mismatch_and_command_registration(self):
        self.assertIn("phocos_gatt_change",ble.COMMANDS)
        self.client.mismatch_readback=True
        r=await self.call({"field":"boost_duration","value":7,"expected":5})
        self.assertEqual(r["status"],"mismatch")

if __name__ == '__main__': unittest.main(verbosity=2)