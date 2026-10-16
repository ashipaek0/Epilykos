"""Offline fake-client tests; no Bleak/adapter needed."""
import asyncio
import unittest
import ble_helper as h

class Client:
    def __init__(self, mtu=23, advertised=True, fail=False):
        self.mtu_size, self.writes, self.fail = mtu, [], fail
        self.properties = ["write-without-response"] if advertised else []
        self.max_write_without_response_size = mtu - 3
        self.services = self
    def get_characteristic(self, uuid): return self
    async def write_gatt_char(self, uuid, data, response=None):
        self.writes.append((bytes(data), response))
        if self.fail: raise TimeoutError("ambiguous")

class Writes(unittest.IsolatedAsyncioTestCase):
    async def test_long_default(self):
        c = Client(); await h.lux_write(c, "ff01", b"a" * 38, "long-response", 0)
        self.assertEqual(c.writes, [(b"a" * 38, True)])
    async def test_chunks(self):
        for mtu, lengths in [(23, [20, 18]), (256, [38])]:
            c = Client(mtu); info = await h.lux_write(c, "ff01", b"a" * 38, "chunked-no-response", 0)
            self.assertEqual([len(x[0]) for x in c.writes], lengths)
            self.assertTrue(all(x[1] is False for x in c.writes))
            self.assertEqual(info["chunkSize"], mtu - 3)
    async def test_refused_before_write(self):
        c = Client(advertised=False)
        with self.assertRaises(h.HelperError): await h.lux_write(c, "ff01", b"a" * 38, "chunked-no-response", 0)
        self.assertEqual(c.writes, [])
    async def test_error_is_not_replayed(self):
        c = Client(fail=True)
        with self.assertRaises(TimeoutError): await h.lux_write(c, "ff01", b"a" * 38, "chunked-no-response", 0)
        self.assertEqual(len(c.writes), 1)

if __name__ == '__main__': unittest.main()
