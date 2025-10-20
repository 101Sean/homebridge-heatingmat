const noble = require('noble');
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
        this.serviceUuid = (config.service_uuid || '').toLowerCase().replace(/-/g, '');
        this.charTempUuid = (config.char_temp_uuid || '').toLowerCase().replace(/-/g, '');
        this.charTimeUuid = (config.char_timer_uuid || '').toLowerCase().replace(/-/g, '');

        this.adapterId = config.adapter_id || 'hci0';
        this.scanInterval = (config.scan_interval_sec || 15) * 1000;

        this.charSetUuid = (config.char_set_uuid || '').toLowerCase().replace(/-/g, '');
        this.initPacketHex = config.init_packet_hex;

        this.manufacturerId = config.manufacturer_id_hex ? parseInt(config.manufacturer_id_hex, 16) : null;
        this.pairingFlagByteIndex = config.pairing_flag_byte_index === undefined ? null : config.pairing_flag_byte_index;
        this.pairingFlagValue = config.pairing_flag_value === undefined ? null : config.pairing_flag_value;

        if (!this.macAddress || !this.serviceUuid || !this.charTempUuid || !this.charTimeUuid) {
            this.log.error('config.json에 필수 설정(mac_address, service_uuid, char_temp_uuid, char_timer_uuid)이 누락되었습니다.');
            return;
        }

        this.name = config.name || '스마트 매트';
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.setCharacteristic = null;
        this.peripheral = null;
        this.isConnected = false;

        this.isScanningLoopActive = false;

        this.currentState = {
            targetTemp: MIN_TEMP,
            currentTemp: MIN_TEMP,
            currentHeatingCoolingState: this.Characteristic.CurrentHeatingCoolingState.OFF,
            timerHours: 0,
            timerOn: false,
            lastHeatTemp: DEFAULT_HEAT_TEMP
        };

        this.initServices();
        this.initNoble();
    }

    async safeWriteValue(characteristic, packet, maxRetries = 2, delayMs = 300) {
        if (!this.isConnected || !characteristic) {
            throw new Error("Device not connected or characteristic invalid.");
        }

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await characteristic.write(packet, true);
                this.log.debug(`[BLE Write] 쓰기 성공 (시도: ${attempt}/${maxRetries}).`);

                await sleep(5000);

                return true;
            } catch (error) {
                this.log.warn(`[BLE Write] 쓰기 오류 발생 (시도: ${attempt}/${maxRetries}): ${error.message}`);

                if (attempt === maxRetries) {
                    this.log.error(`[BLE Write] 최종 쓰기 실패. 연결 해제 및 재시도 루프 시작.`);
                    this.disconnectDevice();
                    throw error;
                }

                await sleep(delayMs);
            }
        }
    }

    initNoble() {
        noble.on('stateChange', (state) => {
            if (state === 'poweredOn') {
                this.log.info('[BLE] Noble 어댑터 켜짐. 스캔 루프 시작.');
                this.startScanningLoop();
            } else {
                this.log.warn(`[BLE] Noble 어댑터 상태 변경: ${state}.`);
                this.disconnectDevice(true);
            }
        });

        noble.on('discover', this.onDiscover.bind(this));
    }

    parseManufacturerData(manufacturerData) {
        let isDeviceFound = false;
        let isParingState = false;

        if (!manufacturerData || !this.manufacturerId || this.pairingFlagByteIndex === null || this.pairingFlagValue === null) {
            return { isDeviceFound: true, isParingState: true };
        }

        if (manufacturerData.length > 0) {
            const manufacturerId = manufacturerData.readUInt8(0);
            isDeviceFound = (manufacturerId & 0xFF) === this.manufacturerId;
        }

        if (isDeviceFound && manufacturerData.length > this.pairingFlagByteIndex) {
            const typeByte = manufacturerData.readUInt8(this.pairingFlagByteIndex);
            isParingState = (typeByte & 0x0F) === this.pairingFlagValue;
        }

        return { isDeviceFound, isParingState };
    }

    onDiscover(peripheral) {
        if (this.isConnected) return;

        const discoveredAddress = peripheral.address.toLowerCase().replace(/[^0-9a-f]/g, '');

        if (discoveredAddress !== this.macAddress) {
            return;
        }

        const adData = this.parseManufacturerData(peripheral.advertisement.manufacturerData);

        if (adData.isDeviceFound && adData.isParingState) {
            this.log.info(`[BLE] 매트 장치 발견 (주소: ${peripheral.address}). 장치 ID 및 페어링 상태 확인됨. 연결 시도.`);
            noble.stopScanning();
            this.connectDevice(peripheral);
        } else {
            this.log.debug(`[BLE] 매트 장치(${peripheral.address}) 발견. 연결 조건 불일치 (ID: ${adData.isDeviceFound}, 페어링: ${adData.isParingState}). 건너뜀.`);
        }
    }

    startScanningLoop() {
        if (this.isScanningLoopActive) return;
        this.isScanningLoopActive = true;

        const scan = () => {
            if (!this.isConnected && noble.state === 'poweredOn') {
                this.log.debug('[BLE] 스캔 시작. 설정된 서비스 UUID로 장치를 찾습니다.');
                noble.startScanning([this.serviceUuid], false);

                setTimeout(() => {
                    if (noble.state === 'scanning') {
                        noble.stopScanning();
                        this.log.debug('[BLE] 스캔 멈춤. 다음 주기 대기.');
                    }
                    if (this.isScanningLoopActive) {
                        setTimeout(scan, this.scanInterval);
                    }
                }, 5000); // 5초 스캔 후 중지
            } else if (this.isScanningLoopActive) {
                setTimeout(scan, this.scanInterval);
            }
        };
        scan();
    }


    async connectDevice(peripheral) {
        if (this.isConnected) return;

        this.peripheral = peripheral;

        this.peripheral.removeAllListeners('disconnect');
        this.peripheral.on('disconnect', () => {
            this.log.warn(`[BLE] 매트 연결 해제됨. 재연결 루프를 시작합니다.`);
            this.disconnectDevice();
            this.startScanningLoop();
        });

        try {
            this.log.info(`[BLE] 매트 연결 시도...`);
            await this.peripheral.connectAsync();
            this.isConnected = true;
            this.log.info(`[BLE] 매트 연결 성공.`);

            await this.discoverCharacteristics();

        } catch (error) {
            this.log.error(`[BLE] 매트 연결 실패: ${error.message}. 재스캔 루프를 시작합니다.`);
            this.disconnectDevice(true);
            this.startScanningLoop();
        }
    }

    async discoverCharacteristics() {
        try {
            this.log.debug(`[BLE] 특성 탐색 대상 서비스: ${this.serviceUuid}`);

            const { characteristics } = await this.peripheral.discoverAllServicesAndCharacteristicsAsync();

            let foundChars = {};
            characteristics.forEach(char => {
                foundChars[char.uuid] = char;
            });

            if (this.charSetUuid) {
                this.setCharacteristic = foundChars[this.charSetUuid];
            }
            this.tempCharacteristic = foundChars[this.charTempUuid];
            this.timeCharacteristic = foundChars[this.charTimeUuid];

            if (this.tempCharacteristic && this.timeCharacteristic) {
                this.log.info('[BLE] 모든 필수 특성 (온도, 타이머) 발견. 제어 준비 완료.');

                if (this.setCharacteristic) {
                    this.log.warn('[Init] 설정된 초기화 특성이 있으나, 연결 끊김 문제(ATT 0x0e) 해결을 위해 초기화 패킷 전송을 건너뜁니다.');
                }

                await this.readCurrentState();
            } else {
                this.log.error(`[BLE] 필수 특성 중 하나를 찾을 수 없습니다. (온도: ${!!this.tempCharacteristic}, 타이머: ${!!this.timeCharacteristic}) 연결 해제.`);
                this.disconnectDevice(true);
            }
        } catch (error) {
            this.log.error(`[BLE] 특성 탐색 오류: ${error.message}.`);
            this.disconnectDevice(true);
        }
    }

    async readCurrentState() {
        try {
            const tempValue = await this.tempCharacteristic.readAsync();
            const currentLevel = tempValue.readUInt8(3);
            const currentTemp = LEVEL_TEMP_MAP[currentLevel] || MIN_TEMP;

            this.currentState.targetTemp = currentTemp;
            this.currentState.currentTemp = currentTemp;
            this.currentState.currentHeatingCoolingState = currentLevel > 0
                ? this.Characteristic.CurrentHeatingCoolingState.HEAT
                : this.Characteristic.CurrentHeatingCoolingState.OFF;
            if (currentLevel > 0) {
                this.currentState.lastHeatTemp = currentTemp;
            }

            this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, this.currentState.targetTemp);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
            this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF
                ? this.Characteristic.TargetHeatingCoolingState.OFF
                : this.Characteristic.TargetHeatingCoolingState.HEAT);

            this.log.debug(`[Sync] 온도 상태 동기화 완료: Level ${currentLevel} -> ${currentTemp}°C. (읽기 인덱스 3 사용)`);

            const timeValue = await this.timeCharacteristic.readAsync();
            const currentHours = timeValue.readUInt8(3);

            this.currentState.timerHours = currentHours;
            this.currentState.timerOn = currentHours > 0;

            this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
            this.timerService.updateCharacteristic(this.Characteristic.Brightness, currentHours * BRIGHTNESS_PER_HOUR);

            this.log.debug(`[Sync] 타이머 상태 동기화 완료: ${currentHours} 시간. (읽기 인덱스 3 사용)`);

        } catch (error) {
            this.log.warn(`[Sync] 초기 상태 읽기 실패 (READ 속성이 없거나 데이터 해석 오류): ${error.message}`);
        }
    }

    disconnectDevice(resetDevice = false) {
        if (this.peripheral && this.isConnected) {
            this.peripheral.disconnect(() => {
                this.log.debug('[BLE] peripheral.disconnect() 완료.');
            });
        }

        this.isConnected = false;
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.setCharacteristic = null;
        if (resetDevice) {
            this.peripheral = null;
        }
        this.startScanningLoop();
    }

    getServices() {
        return [
            this.accessoryInformation,
            this.thermostatService,
            this.timerService
        ];
    }
}

noble.Peripheral.prototype.connectAsync = util.promisify(noble.Peripheral.prototype.connect);
noble.Peripheral.prototype.discoverAllServicesAndCharacteristicsAsync = util.promisify(noble.Peripheral.prototype.discoverAllServicesAndCharacteristics);
noble.Characteristic.prototype.write = util.promisify(noble.Characteristic.prototype.write);
noble.Characteristic.prototype.readAsync = util.promisify(noble.Characteristic.prototype.read);

module.exports = (api) => {
    api.registerAccessory('homebridge-heatingmat', 'HeatingMatAccessory', HeatingMatAccessory);
};