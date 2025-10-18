const NodeBle = require('node-ble');
const util = require('util');

const TEMP_LEVEL_MAP = { 15: 0, 20: 1, 25: 2, 30: 3, 35: 4, 40: 5, 45: 6, 50: 7 };
const LEVEL_TEMP_MAP = { 0: 15, 1: 20, 2: 25, 3: 30, 4: 35, 5: 40, 6: 45, 7: 50 };
const MIN_TEMP = 15;
const MAX_TEMP = 50;
const DEFAULT_HEAT_TEMP = 30;

const MAX_TIMER_HOURS = 10;
const BRIGHTNESS_PER_HOUR = 10;

const sleep = util.promisify(setTimeout);

class HeatingMatAccessory {
    constructor(log, config, api) {
        this.log = log;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;

        this.macAddress = (config.mac_address || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        this.serviceUuid = (config.service_uuid || '').toLowerCase();
        this.charTempUuid = (config.char_temp_uuid || '').toLowerCase();
        this.charTimeUuid = (config.char_time_uuid || '').toLowerCase();

        this.adapterId = config.adapter_id || 'hci0';
        this.scanInterval = (config.scan_interval_sec || 15) * 1000;

        if (!this.macAddress || !this.serviceUuid || !this.charTempUuid || !this.charTimeUuid) {
            this.log.error('config.json에 필수 설정(mac_address, service_uuid, char_temp_uuid, char_time_uuid)이 누락되었습니다.');
            return;
        }

        this.name = config.name || '스마트 히팅 매트';
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.device = null;
        this.adapter = null;
        this.isConnected = false;
        this.isScanningLoopActive = false;

        this.currentState = {
            targetTempL: MIN_TEMP,
            targetTempR: MIN_TEMP,
            currentTempL: MIN_TEMP,
            currentTempR: MIN_TEMP,
            currentHeatingCoolingState: this.Characteristic.CurrentHeatingCoolingState.OFF,
            timerHoursL: 0,
            timerHoursR: 0,
            timerOn: false,
            lastHeatTemp: DEFAULT_HEAT_TEMP
        };

        this.initServices();
        this.initNodeBle();
    }

    createTempPacket(levelL, levelR) {
        const checkSumL = (0xFF - levelL) & 0xFF;
        const checkSumR = (0xFF - levelR) & 0xFF;

        const buffer = Buffer.alloc(4);
        buffer.writeUInt8(levelL, 0);
        buffer.writeUInt8(checkSumL, 1);
        buffer.writeUInt8(levelR, 2);
        buffer.writeUInt8(checkSumR, 3);

        return buffer;
    }

    createTimerPacket(hoursL, hoursR) {
        const checkSumL = (0xFF - hoursL) & 0xFF;
        const checkSumR = (0xFF - hoursR) & 0xFF;

        const buffer = Buffer.alloc(4);
        buffer.writeUInt8(hoursL, 0);
        buffer.writeUInt8(checkSumL, 1);
        buffer.writeUInt8(hoursR, 2);
        buffer.writeUInt8(checkSumR, 3);

        return buffer;
    }


    initServices() {
        this.accessoryInformation = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'Generic Mat')
            .setCharacteristic(this.Characteristic.Model, 'BLE Heating Mat (Single Zone)')
            .setCharacteristic(this.Characteristic.SerialNumber, this.macAddress);

        this.thermostatService = new this.Service.Thermostat(this.name + ' 온도');

        this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 5 })
            .onSet(this.handleSetTargetTemperature.bind(this))
            .onGet(() => this.currentState.targetTempL);

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 1 })
            .onGet(() => this.currentState.currentTempL);

        const targetHeatingCoolingStateCharacteristic = this.thermostatService.getCharacteristic(this.Characteristic.TargetHeatingCoolingState);
        targetHeatingCoolingStateCharacteristic.setProps({
            validValues: [this.Characteristic.TargetHeatingCoolingState.OFF, this.Characteristic.TargetHeatingCoolingState.HEAT]
        });
        targetHeatingCoolingStateCharacteristic
            .onSet(this.handleSetTargetHeatingCoolingState.bind(this))
            .onGet(() => {
                const isOn = this.currentState.targetTempL > MIN_TEMP;
                return isOn
                    ? this.Characteristic.TargetHeatingCoolingState.HEAT
                    : this.Characteristic.TargetHeatingCoolingState.OFF;
            });

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(() => {
                const isOn = this.currentState.targetTempL > MIN_TEMP;
                return isOn
                    ? this.Characteristic.CurrentHeatingCoolingState.HEAT
                    : this.Characteristic.CurrentHeatingCoolingState.OFF;
            });

        this.thermostatService.setCharacteristic(this.Characteristic.TemperatureDisplayUnits, this.Characteristic.TemperatureDisplayUnits.CELSIUS);

        this.timerService = new this.Service.Lightbulb(this.name + ' 타이머 설정');

        this.timerService.getCharacteristic(this.Characteristic.On)
            .onSet(this.handleTimerSwitch.bind(this))
            .onGet(() => this.currentState.timerOn);

        this.timerService.getCharacteristic(this.Characteristic.Brightness)
            .setProps({ minValue: 0, maxValue: 100, minStep: BRIGHTNESS_PER_HOUR })
            .onSet(this.handleSetTimerHours.bind(this))
            .onGet(() => this.currentState.timerHoursL * BRIGHTNESS_PER_HOUR);

        this.timerService.setCharacteristic(this.Characteristic.Brightness, this.currentState.timerHoursL * BRIGHTNESS_PER_HOUR);
        this.timerService.setCharacteristic(this.Characteristic.On, this.currentState.timerOn);
    }

    async handleSetTargetHeatingCoolingState(value) {
        if (value === this.Characteristic.TargetHeatingCoolingState.OFF) {
            this.log.info('[HomeKit] Power OFF received. Setting Left Zone to Level 0 (OFF).');
            await this.sendTempCommand(MIN_TEMP);
        } else if (value === this.Characteristic.TargetHeatingCoolingState.HEAT) {
            this.log.info(`[HomeKit] Power ON received. Restoring to last set temp (${this.currentState.lastHeatTemp}°C).`);
            await this.sendTempCommand(this.currentState.lastHeatTemp);
        }
    }

    async handleSetTargetTemperature(value) {
        await this.sendTempCommand(value);
    }

    async sendTempCommand(tempL) {
        const levelL = TEMP_LEVEL_MAP[Math.round(tempL / 5) * 5] || 0;
        const levelR = 0;

        const actualTempL = LEVEL_TEMP_MAP[levelL];
        const actualTempR = MIN_TEMP;

        const packet = this.createTempPacket(levelL, levelR);
        this.log.info(`[Temp] Setting Left: ${actualTempL}°C (Level ${levelL}). Packet: ${packet.toString('hex')}`);

        if (this.tempCharacteristic && this.isConnected) {
            try {
                await sleep(50);
                await this.tempCharacteristic.writeValueWithoutResponse(packet);

                this.currentState.targetTempL = actualTempL;
                this.currentState.targetTempR = actualTempR;
                this.currentState.currentTempL = actualTempL;
                this.currentState.currentTempR = actualTempR;

                const isOn = actualTempL > MIN_TEMP;
                this.currentState.currentHeatingCoolingState =
                    isOn ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;

                if (isOn) {
                    this.currentState.lastHeatTemp = actualTempL;
                }

                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, actualTempL);
                this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, actualTempL);
                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
                this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, isOn
                    ? this.Characteristic.TargetHeatingCoolingState.HEAT
                    : this.Characteristic.TargetHeatingCoolingState.OFF);

            } catch (error) {
                this.log.error(`[Temp] BLE Write Error: ${error.message}`);
                this.disconnectDevice();
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            this.log.warn('[Temp] BLE not connected. Command failed. (Retrying connection in background)');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }


    async handleSetTimerHours(value) {
        let hours = Math.round(value / BRIGHTNESS_PER_HOUR);

        if (value > 0 && hours === 0) { hours = 1; }
        if (hours > MAX_TIMER_HOURS) { hours = MAX_TIMER_HOURS; }

        await this.sendTimerCommand(hours);

        this.currentState.timerHoursL = hours;
        this.currentState.timerHoursR = 0;
        this.currentState.timerOn = hours > 0;

        const brightnessToSet = hours * BRIGHTNESS_PER_HOUR;

        this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
        this.timerService.updateCharacteristic(this.Characteristic.Brightness, brightnessToSet);
        this.log.info(`[Timer] Brightness ${value}% received -> ${hours} hours set. (HomeKit: ${brightnessToSet}%)`);
    }

    async handleTimerSwitch(value) {
        let hoursToSend = 0;
        let brightnessToSet = 0;

        if (value === false) {
            this.log.info('[Timer] HomeKit Switch OFF. Timer disabled (0 hours).');
        } else {
            let currentBrightness = this.timerService.getCharacteristic(this.Characteristic.Brightness).value;
            hoursToSend = Math.round(currentBrightness / BRIGHTNESS_PER_HOUR);

            if (hoursToSend === 0) {
                hoursToSend = 1;
                this.log.info('[Timer] HomeKit Switch ON. Timer was 0, setting to default 1 hour.');
            }
            brightnessToSet = hoursToSend * BRIGHTNESS_PER_HOUR;
            this.log.info(`[Timer] HomeKit Switch ON. Restoring to ${hoursToSend} hours.`);
        }

        await this.sendTimerCommand(hoursToSend);

        this.currentState.timerHoursL = hoursToSend;
        this.currentState.timerHoursR = 0;
        this.currentState.timerOn = value;

        this.timerService.updateCharacteristic(this.Characteristic.Brightness, brightnessToSet);
    }

    async sendTimerCommand(hoursL) {
        const hoursR = 0;
        const packet = this.createTimerPacket(hoursL, hoursR);
        this.log.info(`[Timer] Attempting to send Left: ${hoursL} hours command. Packet: ${packet.toString('hex')}`);

        if (this.timeCharacteristic && this.isConnected) {
            try {
                await sleep(50);
                await this.timeCharacteristic.writeValueWithoutResponse(packet);
            } catch (error) {
                this.log.error(`[Timer] BLE Write Error (Time: ${hoursL}/0): ${error.message}`);
                this.disconnectDevice();
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            this.log.warn('[Timer] BLE not connected. Command failed. (Retrying connection in background)');
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    initNodeBle() {
        this.initializeBleAdapter();
    }

    async initializeBleAdapter() {
        try {
            this.log.info('[BLE] Attempting to initialize BLE using node-ble.');

            const { bluetooth } = NodeBle.createBluetooth();

            let adapter;
            if (this.adapterId && this.adapterId !== 'hci0') {
                adapter = await bluetooth.getAdapter(this.adapterId);
            } else {
                adapter = await bluetooth.defaultAdapter();
            }

            this.adapter = adapter;
            this.log.info(`[BLE] Adapter (${this.adapterId}) initialized successfully. Starting scan loop.`);
            this.startScanningLoop();
        } catch (error) {
            this.log.error(`[BLE] node-ble initialization failed. Check BlueZ service and permissions: ${error.message}`);
        }
    }

    async startScanningLoop() {
        if (!this.adapter || this.isScanningLoopActive) {
            this.log.debug('[BLE] Scan loop conditions not met (no adapter or already running).');
            return;
        }

        this.isScanningLoopActive = true;
        this.log.info('[BLE] Starting background scan/reconnect loop.');

        while (this.isScanningLoopActive) {
            if (!this.isConnected) {
                this.log.debug('[BLE] Not connected. Starting scan...');
                try {
                    await this.adapter.startDiscovery();

                    const targetAddress = this.macAddress.toUpperCase();

                    await sleep(5000);
                    await this.adapter.stopDiscovery();

                    const deviceAddresses = await this.adapter.devices();

                    let targetDevice = null;
                    let foundAddress = null;

                    for (const address of deviceAddresses) {
                        const normalizedAddress = address.toUpperCase().replace(/:/g, '');

                        if (normalizedAddress === targetAddress) {
                            targetDevice = await this.adapter.getDevice(address);
                            foundAddress = address;
                            break;
                        }
                    }

                    if (targetDevice) {
                        this.device = targetDevice;
                        this.log.info(`[BLE] Mat device found: ${foundAddress}`);
                        await this.connectDevice();
                    } else {
                        if (deviceAddresses.length > 0) {
                            this.log.info(`[BLE] Target device (${targetAddress}) not found.`);
                        } else {
                            this.log.info(`[BLE] Target device (${targetAddress}) not found. No surrounding devices found.`);
                        }
                    }

                } catch (error) {
                    this.log.error(`[BLE] Scan error: ${error.message}`);
                }
            } else {
                this.log.debug('[BLE] Connection maintained. Waiting for next scan cycle.');
            }

            await sleep(this.scanInterval);
        }
    }

    async connectDevice() {
        if (!this.device || this.isConnected) {
            return;
        }

        try {
            this.log.info(`[BLE] Attempting to connect to mat...`);
            await this.device.connect();
            this.isConnected = true;
            this.log.info(`[BLE] Mat connection successful.`);

            this.device.on('disconnect', () => {
                this.log.warn(`[BLE] Mat disconnected. Restarting reconnect loop.`);
                this.disconnectDevice();
            });

            await this.discoverCharacteristics();

        } catch (error) {
            this.log.error(`[BLE] Mat connection failed: ${error.message}. Restarting scan loop.`);
            this.disconnectDevice(true);
        }
    }

    async discoverCharacteristics() {
        try {
            this.log.info(`[BLE] Target Service for discovery: ${this.serviceUuid}`);
            this.log.info(`[BLE] Target Characteristics: (Temp: ${this.charTempUuid}, Time: ${this.charTimeUuid})`);

            await sleep(500);

            const gatt = await this.device.gatt();

            const service = await gatt.getPrimaryService(this.serviceUuid);
            this.log.info(`[BLE] Service ${this.serviceUuid} found successfully.`);

            this.tempCharacteristic = await service.getCharacteristic(this.charTempUuid);
            this.timeCharacteristic = await service.getCharacteristic(this.charTimeUuid);

            if (this.tempCharacteristic && this.timeCharacteristic) {
                this.log.info('[BLE] All required characteristics found. Control ready.');
            } else {
                this.log.error(`[BLE] One or more required characteristics not found. (Temp: ${!!this.tempCharacteristic}, Time: ${!!this.timeCharacteristic}). Disconnecting.`);
                this.disconnectDevice(true);
            }
        } catch (error) {
            this.log.error(`[BLE] Characteristic discovery error: ${error.message}.`);
            this.log.error('[BLE] Please ensure service and characteristic UUIDs in config.json are accurate.');
            this.disconnectDevice(true);
        }
    }

    disconnectDevice(resetDevice = false) {
        const deviceToDisconnect = this.device;

        this.isConnected = false;
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;

        if (resetDevice) {
            this.device = null;
        }

        if (deviceToDisconnect) {
            deviceToDisconnect.isConnected().then(connected => {
                if(connected) {
                    deviceToDisconnect.disconnect().catch(e => this.log.warn(`[BLE] Safe disconnect failed: ${e.message}`));
                }
            }).catch(e => this.log.warn(`[BLE] Error checking connection status (ignored): ${e.message}`));
        }
    }

    getServices() {
        return [
            this.accessoryInformation,
            this.thermostatService,
            this.timerService
        ];
    }
}

module.exports = (api) => {
    api.registerAccessory('homebridge-heatingmat', 'HeatingMatAccessory', HeatingMatAccessory);
};
