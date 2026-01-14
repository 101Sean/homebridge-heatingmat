const NodeBle = require('node-ble');
const { sleep } = require('./utils');

class BleManager {
    constructor(log, config) {
        this.log = log;
        this.macAddress = config.mac_address?.toLowerCase().replace(/[^0-9a-f]/g, '');
        this.serviceUuid = config.service_uuid?.toLowerCase();
        this.charTempUuid = config.char_temp_uuid?.toLowerCase();
        this.charTimeUuid = config.char_timer_uuid?.toLowerCase();
        this.charSetUuid = config.char_set_uuid?.toLowerCase();
        this.initPacketHex = config.init_packet_hex;

        this.adapterId = config.adapter_id || 'hci0';

        this.scanInterval = 5000;
        this.isDeviceConnected = false;
    }

    async initialize() {
        const { bluetooth } = NodeBle.createBluetooth();
        return await bluetooth.defaultAdapter();
    }

    async startScanningLoop(adapter, onDeviceFound) {
        while (true) {
            if (this.isDeviceConnected) {
                await sleep(10000);
                continue;
            }

            try {
                await adapter.startDiscovery();
                await sleep(3000);
                await adapter.stopDiscovery();
                await sleep(1000);

                const devices = await adapter.devices();
                for (const addr of devices) {
                    const normalized = addr.toUpperCase().replace(/:/g, '');
                    if (normalized === this.macAddress.toUpperCase()) {
                        const device = await adapter.getDevice(addr);

                        if (!this.isDeviceConnected) {
                            await onDeviceFound(device);
                        }
                        break;
                    }
                }
            } catch (error) {
                this.log.error(`[BLE] 스캔 오류: ${error.message}`);
            }
            await sleep(this.scanInterval);
        }
    }
}

module.exports = BleManager;