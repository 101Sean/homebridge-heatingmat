const NodeBle = require('node-ble');
const util = require('util');

const WRITE_DELAY_MS = 300;
const KEEP_ALIVE_INTERVAL_MS = 10000;
const KEEP_ALIVE_INITIAL_DELAY_MS = 3000;

const TEMP_LEVEL_MAP = { 0: 0, 36: 1, 37: 2, 38: 3, 39: 4, 40: 5, 41: 6, 42: 7 };
const LEVEL_TEMP_MAP = { 0: 0, 1: 36, 2: 37, 3: 38, 4: 39, 5: 40, 6: 41, 7: 42 };
const MIN_TEMP = 0;
const MAX_TEMP = 42;
const DEFAULT_HEAT_TEMP = 38;

const MAX_TIMER_HOURS = 12; // maximum 15
const BRIGHTNESS_PER_HOUR = 100 / MAX_TIMER_HOURS;

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
        this.charTimeUuid = (config.char_timer_uuid || '').toLowerCase();

        this.adapterId = config.adapter_id || 'hci0';
        this.scanInterval = (config.scan_interval_sec || 15) * 1000;

        this.charSetUuid = (config.char_set_uuid || '').toLowerCase();
        this.initPacketHex = config.init_packet_hex;

        if (!this.macAddress || !this.serviceUuid || !this.charTempUuid || !this.charTimeUuid) {
            this.log.error('config.json에 필수 설정(mac_address, service_uuid, char_temp_uuid, char_timer_uuid)이 누락되었습니다.');
            return;
        }

        this.name = config.name || '스마트 히팅 매트';
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.setCharacteristic = null;
        this.device = null;
        this.adapter = null;
        this.isConnected = false;

        this.isScanningLoopActive = false;

        this.keepAliveTimer = null;
        this.keepAliveInterval = null; // 인터벌 핸들러 추가

        this.setTempTimeout = null;
        this.lastSentLevel = -1;

        this.currentState = {
            targetTemp: 0, // DEFAULT_HEAT_TEMP,
            currentTemp: MIN_TEMP,
            currentHeatingCoolingState: this.Characteristic.CurrentHeatingCoolingState.OFF,
            timerHours: 0,
            timerOn: false,
            lastHeatTemp: DEFAULT_HEAT_TEMP
        };

        this.initServices();
        this.initNodeBle();
    }

    // 첫 번째 Keep-Alive 패킷 전송을 위한 래퍼 함수
    async sendInitialKeepAlivePacket() {
        try {
            await this.sendInitializationPacket(true);
            this.log.debug('[KeepAlive] 첫 번째 초기 Keep-Alive 패킷 전송 완료.');
        } catch (e) {
            this.log.debug('[KeepAlive] 첫 번째 Keep-Alive 패킷 전송 실패. 연결 해제 대기 중.');
        }
    }


    startKeepAlive() {
        this.stopKeepAlive();
        this.log.debug(`[KeepAlive] ${KEEP_ALIVE_INITIAL_DELAY_MS / 1000}초 후 ${KEEP_ALIVE_INTERVAL_MS / 1000}초 간격으로 Keep-Alive 타이머를 시작합니다.`);

        // 1. 초기 지연 시간 후 첫 번째 Keep-Alive 패킷 전송 (3초)
        this.keepAliveTimer = setTimeout(() => {
            if (!this.isConnected) return;

            this.sendInitialKeepAlivePacket();

            // 2. 주기적인 Interval 시작 (10초)
            this.keepAliveInterval = setInterval(async () => {
                if (this.isConnected) {
                    try {
                        await this.sendInitializationPacket(true);
                        this.log.debug('[KeepAlive] 초기화 패킷 재전송 (Keep-Alive).');
                    } catch (e) {
                        this.log.debug('[KeepAlive] Keep-Alive 패킷 전송 실패. 연결 해제 대기 중.');
                    }
                }
            }, KEEP_ALIVE_INTERVAL_MS);
        }, KEEP_ALIVE_INITIAL_DELAY_MS);
    }

    stopKeepAlive() {
        if (this.keepAliveTimer) {
            clearTimeout(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        this.log.debug('[KeepAlive] Keep-Alive 타이머를 중지합니다.');
    }

    async safeWriteValue(characteristic, packet, maxRetries = 3, delayMs = WRITE_DELAY_MS) {
        if (!this.isConnected) {
            throw new Error("Device not connected.");
        }

        const writeOptions = { type: 'command' };

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await characteristic.writeValue(packet, writeOptions);
                this.log.debug(`[BLE Write] 쓰기 성공 (시도: ${attempt}/${maxRetries}, Type: Command).`);

                await sleep(delayMs);

                return true;
            } catch (error) {
                this.log.warn(`[BLE Write] 쓰기 오류 발생 (시도: ${attempt}/${maxRetries}, Type: Command): ${error.message}`);

                if (error.message.includes('0x0e')) {
                    this.log.error('[BLE Write] 치명적인 ATT 오류 발생 (0x0e). 즉시 연결 해제 후 루프 종료.');
                    this.disconnectDevice(true);
                    throw error;
                }

                if (attempt === maxRetries) {
                    this.log.error(`[BLE Write] 최종 쓰기 실패. 연결 해제 및 재시도 루프 시작.`);
                    this.disconnectDevice();
                    throw error;
                }

                await sleep(delayMs);
            }
        }
    }

    createControlPacket(value) {
        const dataByte = value;
        const checkSum = (0xFF - dataByte) & 0xFF;

        const buffer = Buffer.alloc(4);

        buffer.writeUInt8(dataByte, 0);
        buffer.writeUInt8(checkSum, 1);
        buffer.writeUInt8(dataByte, 2);
        buffer.writeUInt8(checkSum, 3);

        return buffer;
    }

    async sendInitializationPacket(isKeepAlive = false) {
        if (!this.setCharacteristic || !this.isConnected || !this.initPacketHex) {
            if (!isKeepAlive) this.log.warn('[Init] 초기화 조건 불충족 (특성/연결/패킷). 건너뛰기.');
            return;
        }

        try {
            const initPacket = Buffer.from(this.initPacketHex, 'hex');
            if (!isKeepAlive) {
                this.log.info(`[Init] 초기화 패킷 전송 시도: ${this.initPacketHex}`);
            }

            // Keep-Alive 패킷은 안정성을 위해 writeWithoutResponse가 아닌 write 요청으로 간주
            await this.setCharacteristic.writeValue(initPacket, { type: 'command' });

            if (!isKeepAlive) {
                await sleep(500);
                this.log.info('[Init] 초기화 패킷 전송 성공.');
            }
        } catch (error) {
            if (!isKeepAlive) {
                this.log.error(`[Init] 초기화 패킷 전송 오류: ${error.message}`);
                this.disconnectDevice(true);
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
            throw error; // Keep-Alive 실패 시 상위 함수에 전파
        }
    }

    initServices() {
        this.accessoryInformation = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'Generic Mat')
            .setCharacteristic(this.Characteristic.Model, 'BLE Heating Mat')
            .setCharacteristic(this.Characteristic.SerialNumber, this.macAddress);

        this.thermostatService = new this.Service.Thermostat(this.name + ' 온도');

        this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 1 })
            .onSet(this.handleSetTargetTemperature.bind(this))
            .onGet(() => this.currentState.targetTemp);

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 1 })
            .onGet(() => this.currentState.currentTemp);

        const targetHeatingCoolingStateCharacteristic = this.thermostatService.getCharacteristic(this.Characteristic.TargetHeatingCoolingState);
        targetHeatingCoolingStateCharacteristic.setProps({
            validValues: [this.Characteristic.TargetHeatingCoolingState.OFF, this.Characteristic.TargetHeatingCoolingState.HEAT]
        });
        targetHeatingCoolingStateCharacteristic
            .onSet(this.handleSetTargetHeatingCoolingState.bind(this))
            .onGet(() => {
                return this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF
                    ? this.Characteristic.TargetHeatingCoolingState.OFF
                    : this.Characteristic.TargetHeatingCoolingState.HEAT;
            });

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(() => this.currentState.currentHeatingCoolingState);

        this.thermostatService.setCharacteristic(this.Characteristic.TemperatureDisplayUnits, this.Characteristic.TemperatureDisplayUnits.CELSIUS);

        this.timerService = new this.Service.Lightbulb(this.name + ' 타이머 설정');

        this.timerService.getCharacteristic(this.Characteristic.On)
            .onSet(this.handleTimerSwitch.bind(this))
            .onGet(() => this.currentState.timerOn);

        this.timerService.getCharacteristic(this.Characteristic.Brightness)
            .setProps({ minValue: 0, maxValue: 100, minStep: BRIGHTNESS_PER_HOUR })
            .onSet(this.handleSetTimerHours.bind(this))
            .onGet(() => this.currentState.timerHours * BRIGHTNESS_PER_HOUR);

        this.timerService.setCharacteristic(this.Characteristic.Brightness, this.currentState.timerHours * BRIGHTNESS_PER_HOUR);
        this.timerService.setCharacteristic(this.Characteristic.On, this.currentState.timerOn);
    }

    async handleSetTargetHeatingCoolingState(value) {
        if (value === this.Characteristic.TargetHeatingCoolingState.OFF) {
            this.log.info('[HomeKit] 전원 OFF 명령 수신. Level 0 으로 설정합니다.');
            this.handleSetTargetTemperature(MIN_TEMP);

        } else if (value === this.Characteristic.TargetHeatingCoolingState.HEAT) {
            this.log.info(`[HomeKit] 전원 ON 명령 수신. 마지막 설정 온도(${this.currentState.lastHeatTemp}°C)로 복구합니다.`);
            this.handleSetTargetTemperature(this.currentState.lastHeatTemp);
        }
    }

    handleSetTargetTemperature(value) {
        let level = 0;
        let displayTemp = 0;

        if (value <= 0) {
            level = 0;
            displayTemp = 0;
        } else {
            if (value < 36) value = 36;

            if (value >= 42) {
                level = 7;
                displayTemp = 42;
            } else {
                level = value - 35;
                displayTemp = value;
            }
        }

        if (level === this.lastSentLevel) {
            if (this.currentState.targetTemp !== displayTemp) {
                this.currentState.targetTemp = displayTemp;
                this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, displayTemp);
            }
            return;
        }

        if (this.setTempTimeout) clearTimeout(this.setTempTimeout);

        this.setTempTimeout = setTimeout(async () => {
            try {
                await this.sendTemperatureCommand(value, level);
            } catch (e) {
                this.log.error(`[Temp Debounce Final Error] 온도 설정 명령 처리 중 BLE 통신 오류 발생: ${e.message}. 프로세스 크래시 방지.`);
            }
        }, 350);
    }

    async sendTemperatureCommand(value, level) {
        this.setTempTimeout = null;

        const packet = this.createControlPacket(level);
        this.log.debug(`[Temp Command] Level ${level} 명령 전송 시도. **패킷:** ${packet.toString('hex')}`);

        if (this.tempCharacteristic && this.isConnected) {
            try {
                await this.safeWriteValue(this.tempCharacteristic, packet);
                this.lastSentLevel = level;

                this.currentState.targetTemp = LEVEL_TEMP_MAP[level];
                this.currentState.currentTemp = LEVEL_TEMP_MAP[level];
                this.currentState.currentHeatingCoolingState =
                    level > 0 ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;

                if (level > 0) {
                    this.currentState.lastHeatTemp = LEVEL_TEMP_MAP[level];
                }

                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
                this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF
                    ? this.Characteristic.TargetHeatingCoolingState.OFF
                    : this.Characteristic.TargetHeatingCoolingState.HEAT);

            } catch (error) {
                this.log.error(`[Temp Command] BLE 쓰기 오류: ${error.message}`);
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            if (level === 0) {
                this.log.warn('[Temp Command] [Startup Skip] BLE 연결이 없어 Level 0 (OFF) 명령 전송을 건너뜁니다.');
                return;
            } else {
                this.log.warn('[Temp Command] BLE 연결 없음. 명령 전송 불가. (백그라운드에서 재연결 시도 중)');
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        }
    }


    async handleSetTimerHours(value) {
        let hours = Math.round(value / BRIGHTNESS_PER_HOUR);

        if (value > 0 && hours === 0) {
            hours = 1;
        }

        if (hours > MAX_TIMER_HOURS) {
            hours = MAX_TIMER_HOURS;
        }

        if (hours === 0) {
            this.log.info('[Timer] 타이머 0시간 설정 수신. 전원을 OFF 합니다.');
            this.handleSetTargetTemperature(MIN_TEMP);
        }

        await this.sendTimerCommand(hours);

        this.currentState.timerHours = hours;
        this.currentState.timerOn = hours > 0;

        const brightnessToSet = hours * BRIGHTNESS_PER_HOUR;

        this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
        this.timerService.updateCharacteristic(this.Characteristic.Brightness, brightnessToSet);
        this.log.info(`[Timer] 밝기 ${value}% 수신 -> ${hours} 시간 설정 완료. (HomeKit: ${brightnessToSet}%)`);
    }

    async handleTimerSwitch(value) {
        let hoursToSend = 0;
        let brightnessToSet = 0;

        if (value === false) {
            hoursToSend = 0;
            brightnessToSet = 0;
            this.log.info('[Timer] HomeKit 스위치 OFF. 타이머 해제 (0시간).');
            this.handleSetTargetTemperature(MIN_TEMP);

        } else {
            let currentBrightness = this.timerService.getCharacteristic(this.Characteristic.Brightness).value;
            hoursToSend = Math.round(currentBrightness / BRIGHTNESS_PER_HOUR);

            if (hoursToSend === 0) {
                hoursToSend = 1;
                brightnessToSet = BRIGHTNESS_PER_HOUR;
                this.log.info('[Timer] HomeKit 스위치 ON. 시간이 0이므로 1시간으로 설정.');
            } else {
                brightnessToSet = hoursToSend * BRIGHTNESS_PER_HOUR;
                this.log.info(`[Timer] HomeKit 스위치 ON. ${hoursToSend}시간으로 재설정.`);
            }
        }

        await this.sendTimerCommand(hoursToSend);

        this.currentState.timerHours = hoursToSend;
        this.currentState.timerOn = value;

        this.timerService.updateCharacteristic(this.Characteristic.Brightness, brightnessToSet);
    }

    async sendTimerCommand(hours) {
        const packet = this.createControlPacket(hours);
        this.log.info(`[Timer] 시간 ${hours} 명령 전송 시도. **패킷:** ${packet.toString('hex')}`);

        if (this.timeCharacteristic && this.isConnected) {
            try {
                await this.safeWriteValue(this.timeCharacteristic, ₩);
            } catch (error) {
                this.log.error(`[Timer] BLE 쓰기 오류 (시간: ${hours}): ${error.message}`);
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            if (hours === 0) {
                this.log.warn('[Timer] [Startup Skip] BLE 연결이 없어 타이머 0시간 (OFF) 명령 전송을 건너킵니다.');
                return;
            } else {
                this.log.warn('[Timer] BLE 연결 없음. 명령 전송 불가. (백그라운드에서 재연결 시도 중)');
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        }
    }

    initNodeBle() {
        this.initializeBleAdapter();
    }

    async initializeBleAdapter() {
        try {
            this.log.info('[BLE] node-ble createBluetooth()를 사용하여 BLE 초기화를 시도합니다.');

            const { bluetooth } = NodeBle.createBluetooth();

            let adapter;
            if (this.adapterId && this.adapterId !== 'hci0') {
                adapter = await bluetooth.getAdapter(this.adapterId);
            } else {
                adapter = await bluetooth.defaultAdapter();
            }

            this.adapter = adapter;
            this.log.info(`[BLE] 어댑터(${this.adapterId}) 초기화 성공. 스캔 루프 시작.`);
            this.startScanningLoop();
        } catch (error) {
            this.log.error(`[BLE] node-ble 초기화 실패. BlueZ 서비스가 실행 중인지, 혹은 권한이 있는지 확인하세요: ${error.message}`);
        }
    }

    async startScanningLoop() {
        if (!this.adapter || this.isScanningLoopActive) {
            this.log.debug('[BLE] 스캔 루프 시작 조건을 만족하지 못했습니다. (어댑터 없음 또는 이미 실행 중)');
            return;
        }

        this.isScanningLoopActive = true;
        this.log.info('[BLE] 백그라운드 스캔/연결 루프를 시작합니다.');

        while (this.isScanningLoopActive) {
            if (!this.isConnected) {
                this.log.debug('[BLE] 장치 연결 상태가 아님. 스캔 시작...');
                try {
                    await this.adapter.startDiscovery();

                    const targetAddress = this.macAddress.toUpperCase();

                    await sleep(5000);
                    await this.adapter.stopDiscovery();

                    // Scan Delay 강화 (5000ms 유지)
                    this.log.debug('[BLE] 스캔 중지 후 어댑터 상태 안정화를 위해 5000ms 대기합니다.');
                    await sleep(5000);

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
                        this.log.info(`[BLE] 매트 장치 발견: ${foundAddress}`);
                        await this.connectDevice();
                    } else {
                        if (deviceAddresses.length > 0) {
                            this.log.debug(`[BLE] 매트 장치(${targetAddress})를 찾지 못했습니다. 발견된 모든 장치 주소: ${deviceAddresses.join(', ')}`);
                        } else {
                            this.log.debug(`[BLE] 매트 장치(${targetAddress})를 찾지 못했습니다. 주변 장치도 발견되지 않았습니다.`);
                        }
                    }

                } catch (error) {
                    this.log.error(`[BLE] 스캔 오류: ${error.message}`);
                }
            } else {
                this.log.debug('[BLE] 연결 상태 유지 중. 다음 스캔 주기까지 대기합니다.');
            }

            await sleep(this.scanInterval);
        }
    }

    async connectDevice() {
        if (!this.device || this.isConnected) {
            return;
        }

        try {
            this.log.info(`[BLE] 매트 연결 시도...`);
            await this.device.connect();
            this.isConnected = true;
            this.log.info(`[BLE] 매트 연결 성공.`);

            this.device.on('disconnect', () => {
                this.log.warn(`[BLE] 매트 연결 해제됨. 재연결 루프를 시작합니다.`);
                this.disconnectDevice();
            });

            // [최종 FIX] 연결 성공 후 GATT 탐색 전에 500ms 지연 추가 (le-connection-abort-by-local 방지 시도)
            await sleep(500);

            await this.discoverCharacteristics();

        } catch (error) {
            this.log.error(`[BLE] 매트 연결 실패: ${error.message}. 재스캔 루프를 시작합니다.`);
            this.disconnectDevice(true);
        }
    }

    async discoverCharacteristics() {
        if (!this.device) return;

        try {
            this.log.debug(`[BLE] 특성 탐색 대상 서비스: ${this.serviceUuid}`);

            const gatt = await this.device.gatt();

            const service = await gatt.getPrimaryService(this.serviceUuid);
            this.log.debug(`[BLE] 서비스 ${this.serviceUuid} 발견 성공.`);

            if (this.charSetUuid) {
                this.setCharacteristic = await service.getCharacteristic(this.charSetUuid);
            }
            this.tempCharacteristic = await service.getCharacteristic(this.charTempUuid);
            this.timeCharacteristic = await service.getCharacteristic(this.charTimeUuid);


            if (this.tempCharacteristic && this.timeCharacteristic) {
                this.log.info('[BLE] 모든 필수 특성 (온도, 타이머) 발견. 제어 준비 완료.');

                if (this.setCharacteristic) {
                    // 최초 연결 후 Initialization Packet을 한번 더 보냅니다 (Keep-Alive와는 별개)
                    await this.sendInitializationPacket();
                }

                // 원본 앱의 3초 지연 로직으로 Keep-Alive 시작
                this.startKeepAlive();

            } else {
                this.log.error(`[BLE] 필수 특성 중 하나를 찾을 수 없습니다. (온도: ${!!this.tempCharacteristic}, 타이머: ${!!this.timeCharacteristic}) 연결 해제.`);
                this.disconnectDevice(true);
            }
        } catch (error) {
            this.log.error(`[BLE] 특성 탐색 오류: ${error.message}.`);
            this.log.error('[BLE] config.json에 서비스 UUID와 특성 UUID를 전체 128비트 형식으로 정확히 입력했는지 확인해 주세요.');
            this.disconnectDevice(true);
        }
    }

    disconnectDevice(resetDevice = false) {
        this.stopKeepAlive();

        const deviceToDisconnect = this.device;

        this.isConnected = false;
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.setCharacteristic = null;

        if (resetDevice) {
            this.device = null;
        }

        if (deviceToDisconnect) {
            deviceToDisconnect.disconnect().catch(e => {
                if (!e.message.includes('not connected') && !e.message.includes('does not exist')) {
                    this.log.warn(`[BLE] 안전한 연결 해제 실패 (D-Bus 오류 방지): ${e.message}`);
                }
            });
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