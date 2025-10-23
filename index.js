const NodeBle = require('node-ble');
const util = require('util');

const TEMP_LEVEL_MAP = { 15: 0, 20: 1, 25: 2, 30: 3, 35: 4, 40: 5, 45: 6, 50: 7 };
const LEVEL_TEMP_MAP = { 0: 15, 1: 20, 2: 25, 3: 30, 4: 35, 5: 40, 6: 45, 7: 50 };
const MIN_TEMP = 15;
const MAX_TEMP = 50;
const DEFAULT_HEAT_TEMP = 30;

const MAX_TIMER_HOURS = 15;
const BRIGHTNESS_PER_HOUR = 100 / MAX_TIMER_HOURS;

const sleep = util.promisify(setTimeout);

const WRITE_DELAY_MS = 300;

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

        this.writeType = (config.write_type || 'request').toLowerCase();
        this.log.info(`[BLE] Write Type 설정: ${this.writeType}. (request = 응답 대기, command = 응답 없음)`);

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

        this.setTempTimeout = null;
        this.lastSentLevel = -1;

        this.currentState = {
            targetTemp: DEFAULT_HEAT_TEMP,
            currentTemp: MIN_TEMP,
            currentHeatingCoolingState: this.Characteristic.CurrentHeatingCoolingState.OFF,
            timerHours: 0,
            timerOn: false,
            lastHeatTemp: DEFAULT_HEAT_TEMP
        };

        this.initServices();
        this.initNodeBle();
    }

    async safeWriteValue(characteristic, packet) {
        if (!this.isConnected) {
            throw new Error("Device not connected.");
        }

        const maxRetries = 3;
        const writeOptions = { type: this.writeType };
        const writeTypeLog = this.writeType === 'request' ? 'Request (응답 대기)' : 'Command (응답 없음)';

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // writeValue(data, options) 형태로 사용
                await characteristic.writeValue(packet, writeOptions);
                this.log.debug(`[BLE Write] 쓰기 성공 (시도: ${attempt}/${maxRetries}, Type: ${writeTypeLog}).`);

                // Android 앱에서 쓰기 후 사용하는 지연 시간 반영 (성공/실패 여부와 관계없이)
                await sleep(WRITE_DELAY_MS);

                return true;
            } catch (error) {
                this.log.warn(`[BLE Write] 쓰기 오류 발생 (시도: ${attempt}/${maxRetries}, Type: ${writeTypeLog}): ${error.message}`);

                // 치명적인 ATT 오류 발생 시 즉시 연결 해제 및 루프 종료
                if (error.message.includes('0x0e') && this.writeType === 'request') {
                    this.log.error('[BLE Write] 치명적인 ATT 오류 발생 (0x0e). 즉시 연결 해제 후 루프 종료. config.json에 "write_type": "command" 설정을 시도해 보세요.');
                    this.disconnectDevice(true);
                    throw error;
                }

                if (attempt === maxRetries) {
                    this.log.error(`[BLE Write] 최종 쓰기 실패. 연결 해제 및 재시도 루프 시작.`);
                    this.disconnectDevice(); // 최종 실패 시 연결 해제 후 재연결 시도
                    throw error;
                }

                if (error.message.includes('Not connected')) {
                    this.log.warn(`[BLE Write] 'Not connected' 오류 감지. 연결 플래그 초기화 후 재시도 루프 시작.`);
                    this.isConnected = false; // <-- 강제로 플래그를 false로 설정하여 루프 즉시 시작
                }

                if (attempt === maxRetries) {
                    this.log.error(`[BLE Write] 최종 쓰기 실패. 연결 해제 및 재시도 루프 시작.`);
                    this.disconnectDevice(); // 최종 실패 시 연결 해제 후 재연결 시도
                    throw error;
                }

                // 실패했더라도 다음 재시도를 위해 딜레이 적용
                await sleep(WRITE_DELAY_MS);
            }
        }
    }

    createControlPacket(value) {
        const dataByte = value;
        const checkSum = (0xFF - dataByte) & 0xFF;

        const buffer = Buffer.alloc(4);

        // Left Zone
        buffer.writeUInt8(dataByte, 0);
        buffer.writeUInt8(checkSum, 1);

        // Right Zone
        buffer.writeUInt8(dataByte, 2);
        buffer.writeUInt8(checkSum, 3);

        return buffer;
    }

    async sendInitializationPacket() {
        if (!this.setCharacteristic || !this.isConnected || !this.initPacketHex) {
            this.log.warn('[Init] 초기화 조건 불충족 (특성/연결/패킷). 건너뛰기.');
            return;
        }

        try {
            const initPacket = Buffer.from(this.initPacketHex, 'hex');
            this.log.info(`[Init] 초기화 패킷 전송 시도: ${this.initPacketHex}`);

            await this.setCharacteristic.writeValue(initPacket, { type: 'command' });
            await sleep(500);

            this.log.info('[Init] 초기화 패킷 전송 성공.');
        } catch (error) {
            this.log.error(`[Init] 초기화 패킷 전송 오류: ${error.message}`);
            // 초기화 실패 시에는 치명적 오류로 간주하고 연결 해제 후 재연결 시도
            this.disconnectDevice(true);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    initServices() {
        this.accessoryInformation = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'Generic Mat')
            .setCharacteristic(this.Characteristic.Model, 'BLE Heating Mat')
            .setCharacteristic(this.Characteristic.SerialNumber, this.macAddress);

        this.thermostatService = new this.Service.Thermostat(this.name + ' 온도');

        this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 5 })
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
            this.log.info('[HomeKit] 전원 OFF 명령 수신. Level 0 (15°C)로 설정합니다.');
            this.handleSetTargetTemperature(MIN_TEMP);

        } else if (value === this.Characteristic.TargetHeatingCoolingState.HEAT) {
            this.log.info(`[HomeKit] 전원 ON 명령 수신. 마지막 설정 온도(${this.currentState.lastHeatTemp}°C)로 복구합니다.`);
            this.handleSetTargetTemperature(this.currentState.lastHeatTemp);
        }
    }

    handleSetTargetTemperature(value) {
        let level = TEMP_LEVEL_MAP[Math.round(value / 5) * 5] || 0;
        if (value < MIN_TEMP) level = 0;
        if (value >= MAX_TEMP) level = 7;

        this.log.debug(`[Temp Debounce] HomeKit ${value}°C 설정 -> Level ${level}. (최종 명령 대기 중)`);

        if (level === this.lastSentLevel && this.currentState.targetTemp === value) {
            this.log.info(`[Temp Debounce] Level ${level}은 이미 전송된 값입니다. 명령 전송을 건너뜁니다.`);
            return;
        }

        if (this.setTempTimeout) {
            clearTimeout(this.setTempTimeout);
        }

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
        this.log.info(`[Temp Command] Level ${level} 명령 전송 시도. **패킷:** ${packet.toString('hex')}`);

        if (this.tempCharacteristic && this.isConnected) {
            try {
                // safeWriteValue에 재시도 로직 적용
                await this.safeWriteValue(this.tempCharacteristic, packet);
                this.lastSentLevel = level;

                // HomeKit 상태 업데이트 (성공 시 즉시 반영)
                this.currentState.targetTemp = value;
                this.currentState.currentTemp = LEVEL_TEMP_MAP[level];
                this.currentState.currentHeatingCoolingState =
                    level > 0 ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;

                if (level > 0) {
                    this.currentState.lastHeatTemp = value;
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
                // safeWriteValue에 재시도 로직 적용
                await this.safeWriteValue(this.timeCharacteristic, packet);
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

    handleTempNotification(data) {
        if (data.length < 1) {
            this.log.warn(`[Temp Status] 수신 패킷이 너무 짧습니다. 길이: ${data.length}`);
            return;
        }

        const newLevel = data.readUInt8(0);
        const validLevel = Math.max(0, Math.min(7, newLevel));
        const newTemp = LEVEL_TEMP_MAP[validLevel] || MIN_TEMP;

        if (this.lastSentLevel !== validLevel) {
            this.log.info(`[Status Sync: Temp] 장치 상태 수신. Level: ${validLevel} (${newTemp}°C). HomeKit 상태 동기화.`);

            this.currentState.targetTemp = newTemp;
            this.currentState.currentTemp = newTemp;
            this.lastSentLevel = validLevel;

            this.currentState.currentHeatingCoolingState =
                validLevel > 0 ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;

            if (validLevel > 0) {
                this.currentState.lastHeatTemp = newTemp;
            }

            this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, newTemp);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
            this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF
                ? this.Characteristic.TargetHeatingCoolingState.OFF
                : this.Characteristic.TargetHeatingCoolingState.HEAT);
        }
    }

    handleTimeNotification(data) {
        if (data.length < 1) {
            this.log.warn(`[Time Status] 수신 패킷이 너무 짧습니다. 길이: ${data.length}`);
            return;
        }

        const newTimerHours = data.readUInt8(0);
        const validTimerHours = Math.max(0, Math.min(MAX_TIMER_HOURS, newTimerHours));
        const newTimerOn = validTimerHours > 0;

        if (this.currentState.timerHours !== validTimerHours) {
            this.log.info(`[Status Sync: Time] 장치 상태 수신. 타이머: ${validTimerHours}시간. HomeKit 상태 동기화.`);

            this.currentState.timerHours = validTimerHours;
            this.currentState.timerOn = newTimerOn;

            this.timerService.updateCharacteristic(this.Characteristic.On, newTimerOn);
            this.timerService.updateCharacteristic(this.Characteristic.Brightness, validTimerHours * BRIGHTNESS_PER_HOUR);
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
            await sleep(500);

            await this.device.connect();
            this.isConnected = true;
            this.log.info(`[BLE] 매트 연결 성공.`);

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

            // 연결 직후 안정화 딜레이 추가
            await sleep(2000);

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

                if (this.charSetUuid && this.initPacketHex) {
                    await this.sendInitializationPacket();
                }

                this.log.info('[BLE] Link Layer 안정화를 위해 1000ms 대기합니다.');
                await sleep(1000);

                // 1. 온도 특성 Notification 구독 시도
                this.log.info(`[BLE] 온도 특성(${this.charTempUuid}) Notification 구독을 시도합니다.`);
                try {
                    this.tempCharacteristic.on('valuechanged', (data) => {
                        this.handleTempNotification(data);
                    });
                    await this.tempCharacteristic.startNotifications();
                    this.log.info('[BLE] 온도 특성 Notification 구독 성공.');
                } catch (error) {
                    // Notification 구독 실패는 연결 해제 없이 단순 경고만 남기고 진행
                    this.log.warn(`[BLE] 온도 특성 Notification 구독 실패 (연결 유지): ${error.message}`);
                }

                // 2. 타이머 특성 Notification 구독 시도
                this.log.info(`[BLE] 타이머 특성(${this.charTimeUuid}) Notification 구독을 시도합니다.`);
                try {
                    this.timeCharacteristic.on('valuechanged', (data) => {
                        this.handleTimeNotification(data);
                    });
                    await this.timeCharacteristic.startNotifications();
                    this.log.info('[BLE] 타이머 특성 Notification 구독 성공.');
                } catch (error) {
                    // Notification 구독 실패는 연결 해제 없이 단순 경고만 남기고 진행
                    this.log.warn(`[BLE] 타이머 특성 Notification 구독 실패 (연결 유지): ${error.message}`);
                }
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
        const deviceToDisconnect = this.device;

        this.isConnected = false;
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.setCharacteristic = null;

        if (resetDevice) {
            this.device = null;
        }

        if (deviceToDisconnect) {
            deviceToDisconnect.isConnected().then(connected => {
                if(connected) {
                    deviceToDisconnect.disconnect().catch(e => this.log.warn(`[BLE] 안전한 연결 해제 실패: ${e.message}`));
                }
            }).catch(e => this.log.warn(`[BLE] 연결 상태 확인 중 오류 발생 (무시): ${e.message}`));
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