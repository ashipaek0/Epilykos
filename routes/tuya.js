/**
 * Tuya helper routes (mounted at /api): scan the network for devices, fetch them from the Tuya cloud or a
 * Smart Life QR login, and test a device. Each route needs a signed-in session.
 *
 * @module routes/tuya
 */
const express = require('express');
const { logger } = require('../modules/logger');
const { isAuthenticated } = require('../modules/sessionAuth');
const { fetchCloudDevices, generateQrCode, pollQrLogin, fetchDevicesOAuth, discoverTuyaDevices, testTuyaDevice, verifyAllTuyaDevices } = require('../modules/tuya');

const router = express.Router();

router.get('/tuya-discover', isAuthenticated, async (req, res) => {
  try {
    // Accept optional ?subnet=192.168.0.0/24 for cross-subnet directed scan
    const rawSubnet = req.query.subnet;
    const subnet = Array.isArray(rawSubnet) ? rawSubnet[0] : (rawSubnet || '');
    if (subnet) {
      // SSRF guard (#71): the directed scan TCP-probes every IP in the subnet
      // from this host, so it must be a valid IPv4 CIDR AND an RFC1918 network.
      const cidrMatch = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(subnet);
      if (!cidrMatch) return res.status(400).json({ error: 'Invalid subnet (expected CIDR like 192.168.0.0/24)' });
      const octets = cidrMatch.slice(1, 5).map(Number);
      const prefix = Number(cidrMatch[5]);
      const invalidOctet = octets.some(o => o > 255);
      const invalidPrefix = prefix > 32;
      const inRfc1918 = (octets[0] === 10) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
      if (invalidOctet || invalidPrefix || !inRfc1918) return res.status(400).json({ error: 'Subnet must be a private RFC1918 network' });
    }
    const devices = await discoverTuyaDevices(subnet || undefined);
    res.json({ success: true, devices });
  } catch (err) {
    logger.error('[Tuya] Discover error:', err);
    res.status(500).json({ error: 'Discovery failed' });
  }
});

router.post('/tuya-cloud-fetch', isAuthenticated, async (req, res) => {
  try {
    const { region, access_id, access_secret, user_id } = req.body;
    const devices = await fetchCloudDevices(region, access_id, access_secret, user_id);
    res.json({ success: true, devices });
  } catch (err) {
    logger.error('[Tuya] Cloud fetch error:', err);
    res.status(500).json({ error: 'Cloud fetch failed' });
  }
});

// Smart Life OAuth flow — QR code login (replaces the IoT API credential flow)
router.post('/tuya-generate-qr', isAuthenticated, async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'UID is required' });
    const result = await generateQrCode(uid);
    // Drawn here: the login token must not go to a third-party QR service.
    if (result && result.qr_url) result.qr_svg = await require('qrcode').toString(result.qr_url, { type: 'svg', margin: 1, width: 220 });
    res.json(result);
  } catch (err) {
    logger.error('[Tuya] QR generate error:', err);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

router.post('/tuya-poll-login', isAuthenticated, async (req, res) => {
  try {
    const { qr_token, uid } = req.body;
    if (!qr_token || !uid) return res.status(400).json({ error: 'qr_token and uid are required' });
    const result = await pollQrLogin(qr_token, uid);
    res.json(result);
  } catch (err) {
    logger.error('[Tuya] Poll login error:', err);
    res.status(500).json({ error: 'Login poll failed' });
  }
});

router.post('/tuya-fetch-oauth', isAuthenticated, async (req, res) => {
  try {
    const { token_info } = req.body;
    if (!token_info) return res.status(400).json({ error: 'token_info is required' });
    const devices = await fetchDevicesOAuth(token_info);
    res.json({ success: true, devices });
  } catch (err) {
    logger.error('[Tuya] OAuth fetch error:', err);
    res.status(500).json({ error: 'OAuth device fetch failed' });
  }
});

router.post('/test-tuya', isAuthenticated, async (req, res) => {
  try {
    const { dev_id, address, local_key, version } = req.body;
    const result = await testTuyaDevice({ dev_id, address, local_key, version });
    res.json(result);
  } catch (err) {
    logger.error('[Tuya] Test error:', err);
    res.status(500).json({ error: 'Test failed' });
  }
});

router.post('/tuya-verify-all', isAuthenticated, async (req, res) => {
  try {
    const { devices } = req.body;
    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'devices array is required' });
    }
    const results = await verifyAllTuyaDevices(devices);
    const successCount = results.filter(r => r.success).length;
    const totalCount = results.length;
    res.json({ success: true, results, summary: `${successCount}/${totalCount} devices connected` });
  } catch (err) {
    logger.error('[Tuya] Verify all error:', err);
    res.status(500).json({ error: 'Verify all failed' });
  }
});

module.exports = router;
