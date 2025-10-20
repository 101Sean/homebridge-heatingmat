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

class HeatingMatAccessory {
    constructor(log, config, api) {
        this.log = log;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;

        this.macAddress = (config.mac_address || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        this.serviceUuid = (config.service_uuid || '').toLowerCase();

        // 제어/알림/읽기용 특성 UUID (동일한 UUID 사용)
        this.charTempUuid = (config.char_temp_uuid || '').toLowerCase();
        this.charTimeUuid = (config.char_timer_uuid || '').toLowerCase();

        this.adapterId = config.adapter_id || 'hci0';
        this.scanInterval = (config.scan_interval_sec || 15) * 1000;

        // 초기화 패킷용 특성
        this.charSetUuid = (config.char_set_uuid || '').toLowerCase();
        this.initPacketHex = config.init_packet_hex;

        if (!this.macAddress || !this.serviceUuid || !this.charTempUuid || !this.charTimeUuid) {
            this.log.error('config.json에 필수 설정(mac_address, service_uuid, char_temp_uuid, char_timer_uuid)이 누락되었습니다.');
            return;
        }

        this.name = config.name || '스마트 히팅 매트';

        // BLE 특성 객체 저장소. (하나의 특성이 Read/Write/Notify 모두 처리)
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.setCharacteristic = null;

        this.isTempNotifyActive = false;
        this.isTimeNotifyActive = false;

        this.device = null;
        this.adapter = null;
        this.isConnected = false;

        this.isScanningLoopActive = false;

        this.setTempTimeout = null;
        this.lastSentLevel = -1;

        // 초기 상태
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

    /**
     * BLE 특성에 값을 쓰는 안전한 함수.
     * Write Without Response (type: 'command')를 기본으로 사용하여 ATT 0x0e 오류를 회피 시도합니다.
     */
    async safeWriteValue(characteristic, packet, maxRetries = 3, delayMs = 300) {
        if (!this.isConnected) {
            throw new Error("Device not connected.");
        }

        const writeOptions = { type: 'command' };

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await characteristic.writeValue(packet, writeOptions);
                this.log.debug(`[BLE Write] 쓰기 성공 (시도: ${attempt}/${maxRetries}, Type: Command).`);

                await sleep(500);

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

    /**
     * 싱글 모드 장치를 위해 좌/우 영역에 동일한 제어 값을 포함하는 패킷을 생성합니다.
     * * [수정] 일반적인 4바이트 제어 패킷 구조 (Level, Level, Padding, Padding)로 변경되었습니다.
     * @param {number} value 제어 레벨 (0-7 또는 타이머 시간)
     * @returns {Buffer} 4바이트 제어 패킷
     */
    createControlPacket(value) {
        const dataByte = value; // Level (0-7 또는 Timer Hours)

        const buffer = Buffer.alloc(4);

        // 1. 좌측 영역 (Left Zone) - 제어 레벨
        buffer.writeUInt8(dataByte, 0);

        // 2. 우측 영역 (Right Zone) - 싱글 모드이므로 좌측과 동일한 값 복사
        buffer.writeUInt8(dataByte, 1);

        // 3 & 4. 나머지 2바이트는 0x00으로 패딩 (대부분의 4바이트 제어 특성에서 요구되는 형태)
        buffer.writeUInt8(0x00, 2);
        buffer.writeUInt8(0x00, 3);

        this.log.debug(`[Packet] Level ${value} -> 패킷 생성: ${buffer.toString('hex')}`);

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
            this.disconnectDevice(true);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    // --- 수동 조작 감지를 위한 데이터 파싱 및 HomeKit 업데이트 ---

    /**
     * 온도/전원 관련 Notification 데이터를 파싱하고 HomeKit 상태를 업데이트합니다.
     * 싱글 모드 장치는 보통 인덱스 0 또는 1에 실제 값을 포함합니다.
     */
    parseAndUpdateTemperature(data) {
        // [수동 조작 감지 1]: 온도 데이터 파싱 및 HomeKit 업데이트
        if (!data || data.length < 1) { // 최소 1바이트 이상이어야 함
            this.log.warn(`[Notify] 온도 데이터가 너무 짧습니다: ${data ? data.toString('hex') : 'null'}`);
            return;
        }

        // 싱글 모드 장치에서는 주로 첫 번째 바이트(인덱스 0)에 상태 값이 옵니다.
        let level = data.readUInt8(0);

        this.log.debug(`[Notify] 패킷 감지 (${data.toString('hex')}). Level을 인덱스 0에서 읽습니다: ${level}`);


        const newTemp = LEVEL_TEMP_MAP[level] || MIN_TEMP;

        this.log.info(`[Notify] 매트 온도 변경 감지. Level: ${level} -> ${newTemp}°C (원본 데이터: ${data.toString('hex')})`);

        // Level 0이면 OFF, 아니면 HEAT
        const newHeatState = level > 0 ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;

        // HomeKit 상태 업데이트
        this.currentState.currentTemp = newTemp;
        this.currentState.targetTemp = newTemp; // 수동 조작 시 목표 온도도 현재 값으로 동기화
        this.currentState.currentHeatingCoolingState = newHeatState;

        // TargetHeatingCoolingState 업데이트 (OFF/HEAT 스위치 동기화)
        const newTargetState = newHeatState === this.Characteristic.CurrentHeatingCoolingState.OFF
            ? this.Characteristic.TargetHeatingCoolingState.OFF
            : this.Characteristic.TargetHeatingCoolingState.HEAT;

        if (level > 0) {
            this.currentState.lastHeatTemp = newTemp;
        }

        this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
        this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, this.currentState.targetTemp);
        this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, newHeatState);
        this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, newTargetState);
    }

    /**
     * 타이머 관련 Notification 데이터를 파싱하고 HomeKit 상태를 업데이트합니다.
     */
    parseAndUpdateTimer(data) {
        // [수동 조작 감지 2]: 타이머 데이터 파싱 및 HomeKit 업데이트
        if (!data || data.length < 1) { // 최소 1바이트 이상이어야 함
            this.log.warn(`[Notify] 타이머 데이터가 너무 짧습니다: ${data ? data.toString('hex') : 'null'}`);
            return;
        }

        // 싱글 모드 장치에서는 주로 첫 번째 바이트(인덱스 0)에 타이머 시간이 옵니다.
        let hours = data.readUInt8(0);
        this.log.debug(`[Notify] 패킷 감지 (${data.toString('hex')}). Hours를 인덱스 0에서 읽습니다: ${hours}`);


        if (hours > MAX_TIMER_HOURS) {
            hours = 0; // 255시간과 같은 비정상적인 값은 0시간(OFF)으로 처리
            this.log.warn(`[Notify] 비정상적인 타이머 값(${data.toString('hex')}) 감지. 0시간으로 재설정.`);
        }

        const newTimerOn = hours > 0;
        const newBrightness = hours * BRIGHTNESS_PER_HOUR;

        this.log.info(`[Notify] 매트 타이머 변경 감지. ${hours} 시간. (HomeKit 밝기: ${newBrightness.toFixed(1)}%) (원본 데이터: ${data.toString('hex')})`);

        // HomeKit 상태 업데이트
        this.currentState.timerHours = hours;
        this.currentState.timerOn = newTimerOn;

        this.timerService.updateCharacteristic(this.Characteristic.On, newTimerOn);
        this.timerService.updateCharacteristic(this.Characteristic.Brightness, newBrightness);
    }

    // --- END of Data Parsing ---

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

        // CurrentTemperature는 실제 온도(읽기) 또는 목표 온도로 사용 (초기에는 MIN_TEMP)
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

        // Brightness MinStep을 15시간에 맞게 조정
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
        // 1. 목표 Level 계산
        let level = TEMP_LEVEL_MAP[Math.round(value / 5) * 5] || 0;
        if (value < MIN_TEMP) level = 0;
        if (value >= MAX_TEMP) level = 7;

        this.log.debug(`[Temp Debounce] HomeKit ${value}°C 설정 -> Level ${level}. (최종 명령 대기 중)`);

        // 2. 중복 Level 명령 방지
        if (level === this.lastSentLevel && this.currentState.targetTemp === value) {
            this.log.info(`[Temp Debounce] Level ${level}은 이미 전송된 값입니다. 명령 전송을 건너뜁니다.`);
            return;
        }

        // 3. 기존 타이머 제거
        if (this.setTempTimeout) {
            clearTimeout(this.setTempTimeout);
        }

        // 4. 350ms 지연 후 실제 명령 전송 (앱 분석 결과 반영)
        this.setTempTimeout = setTimeout(async () => {
            try {
                await this.sendTemperatureCommand(value, level);
            } catch (e) {
                this.log.error(`[Temp Debounce Final Error] 온도 설정 명령 처리 중 BLE 통신 오류 발생: ${e.message}. 프로세스 크래시 방지.`);
            }
        }, 350);
    }

    async sendTemperatureCommand(value, level) {
        this.setTempTimeout = null; // 타이머 완료

        const packet = this.createControlPacket(level);
        this.log.info(`[Temp Command] Level ${level} 명령 전송 시도. **패킷:** ${packet.toString('hex')}`);

        if (this.tempCharacteristic && this.isConnected) {
            try {
                await this.safeWriteValue(this.tempCharacteristic, packet);
                this.lastSentLevel = level; // 성공 시 마지막 전송 레벨 업데이트

                // --- HomeKit 상태 업데이트 (성공 시 즉시 반영) ---
                this.currentState.targetTemp = value;
                this.currentState.currentTemp = LEVEL_TEMP_MAP[level];
                this.currentState.currentHeatingCoolingState =
                    level > 0 ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;

                if (level > 0) {
                    this.currentState.lastHeatTemp = value;
                }

                // HomeKit 상태 업데이트 (즉시 반영)
                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.currentState.currentTemp);
                this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
                this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF
                    ? this.Characteristic.TargetHeatingCoolingState.OFF
                    : this.Characteristic.TargetHeatingCoolingState.HEAT);
                // ----------------------------------------------------

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
        // 1. 밝기 값으로 시간 계산
        let hours = Math.round(value / BRIGHTNESS_PER_HOUR);

        if (value > 0 && hours === 0) {
            hours = 1;
        }

        if (hours > MAX_TIMER_HOURS) {
            hours = MAX_TIMER_HOURS;
        }

        // 2. 0시간일 시 전원 OFF 명령을 추가
        if (hours === 0) {
            this.log.info('[Timer] 타이머 0시간 설정 수신. 전원을 OFF 합니다.');
            this.handleSetTargetTemperature(MIN_TEMP);
        }

        // 3. 타이머 명령 전송
        await this.sendTimerCommand(hours);

        // 4. HomeKit 상태 업데이트
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
            await this.device.connect();
            this.isConnected = true;
            this.log.info(`[BLE] 매트 연결 성공.`);

            // 연결 해제 이벤트 리스너 추가
            this.device.on('disconnect', () => {
                this.log.warn(`[BLE] 매트 연결 해제됨. 재연결 루프를 시작합니다.`);
                this.disconnectDevice();
            });

            await this.discoverCharacteristics();

            // 특성 발견 및 알림 구독 후, 초기 상태를 한 번 읽어옵니다.
            await this.readCurrentState();


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

            // 1. 제어(쓰기/읽기/알림) 특성
            if (this.charSetUuid) {
                this.setCharacteristic = await service.getCharacteristic(this.charSetUuid);
            }
            // 온도와 시간 특성 객체를 할당
            this.tempCharacteristic = await service.getCharacteristic(this.charTempUuid);
            this.timeCharacteristic = await service.getCharacteristic(this.charTimeUuid);


            if (this.tempCharacteristic && this.timeCharacteristic) {
                this.log.info('[BLE] 모든 필수 특성 (온도, 타이머) 발견. 제어 준비 완료.');

                // 초기화 패킷 전송
                if (this.setCharacteristic) {
                    await this.sendInitializationPacket();
                }

                // 수동 조작 감지를 위한 알림(Notification) 구독 시도
                await this.subscribeToNotifications();


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

    // 알림 구독 함수 (동일한 특성 객체 사용)
    async subscribeToNotifications() {
        this.log.info('[Notify] 알림 구독 시도 (수동 조작 감지).');

        // A. 온도 알림 구독 (tempCharacteristic 재사용)
        if (this.tempCharacteristic) {
            try {
                this.tempCharacteristic.on('valuechanged', (data) => {
                    this.parseAndUpdateTemperature(data);
                });
                await this.tempCharacteristic.startNotifications();
                this.isTempNotifyActive = true;
                this.log.info(`[Notify] 온도 알림 구독 성공 (${this.charTempUuid}).`);
            } catch (error) {
                this.log.warn(`[Notify] 온도 알림 구독 실패 (${this.charTempUuid}): ${error.message}. 수동 조작 감지 불가.`);
                this.isTempNotifyActive = false;
            }
        }

        // B. 타이머 알림 구독 (timeCharacteristic 재사용)
        if (this.timeCharacteristic) {
            try {
                this.timeCharacteristic.on('valuechanged', (data) => {
                    this.parseAndUpdateTimer(data);
                });
                await this.timeCharacteristic.startNotifications();
                this.isTimeNotifyActive = true;
                this.log.info(`[Notify] 타이머 알림 구독 성공 (${this.charTimeUuid}).`);
            } catch (error) {
                this.log.warn(`[Notify] 타이머 알림 구독 실패 (${this.charTimeUuid}): ${error.message}. 수동 조작 감지 불가.`);
                this.isTimeNotifyActive = false;
            }
        }

        this.log.info('[Notify] 알림 구독 시도 완료.');
    }


    // 현재 상태 읽기 함수 (동일한 특성 객체 사용)
    async readCurrentState() {
        this.log.info('[Sync] 초기 상태 동기화 시도 (Read Characteristic).');

        // 1. 온도 상태 읽기 시도 (tempCharacteristic 재사용)
        if (this.tempCharacteristic) {
            try {
                const data = await this.tempCharacteristic.readValue();
                this.log.info(`[Sync] 온도 초기 값 읽기 성공: ${data.toString('hex')}`);
                this.parseAndUpdateTemperature(data);
            } catch (error) {
                this.log.warn(`[Sync] 온도 초기 값 읽기 실패: ${error.message}. 초기 온도 동기화 불가.`);
            }
        } else {
            this.log.warn('[Sync] 온도 특성이 없어 읽기 시도 불가.');
        }

        // 2. 타이머 상태 읽기 시도 (timeCharacteristic 재사용)
        if (this.timeCharacteristic) {
            try {
                const data = await this.timeCharacteristic.readValue();
                this.log.info(`[Sync] 타이머 초기 값 읽기 성공: ${data.toString('hex')}`);
                this.parseAndUpdateTimer(data);
            } catch (error) {
                this.log.warn(`[Sync] 타이머 초기 값 읽기 실패: ${error.message}. 초기 타이머 동기화 불가.`);
            }
        } else {
            this.log.warn('[Sync] 타이머 특성이 없어 읽기 시도 불가.');
        }

        this.log.info('[Sync] 초기 상태 동기화 완료.');
    }


    disconnectDevice(resetDevice = false) {
        const deviceToDisconnect = this.device;

        this.isConnected = false;
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.setCharacteristic = null;

        this.isTempNotifyActive = false;
        this.isTimeNotifyActive = false;


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
