/* Epilykos — single source of truth for source/group labels shared by the setup wizard and the Settings page. Classic script; loaded by setup.html and settings.html before their main script. */
(function () {
  'use strict';
  window.EPILYKOS_LABELS = {
    subnav: {
      ha: 'Home Assistant',
      mqtt: 'MQTT',
      modbus: 'Modbus (RS485 / TCP)',
      rs232: 'RS232 (direct serial)',
      external: 'REST API',
      bms: 'BMS — Bluetooth',
      dongle: 'Inverter — Dongle',
      tuya: 'Tuya',
      pvoutput: 'PVOutput'
    },
    transportModbus: {
      tcp: 'TCP (Modbus-TCP)',
      serial: 'Serial (RS485 / Modbus-RTU)'
    },
    groups: {
      inverterWired: 'Inverter — Wired',
      inverterWireless: 'Inverter — Wireless (TCP/IP)',
      inverterDongle: 'Inverter — Dongle',
      bmsBluetooth: 'BMS — Bluetooth',
      bmsWired: 'BMS — Wired',
      ha: 'Home Assistant',
      mqtt: 'MQTT',
      rest: 'REST API',
      tuya: 'Tuya'
    }
  };
})();
