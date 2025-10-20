const NodeBle = require('node-ble');
const util = require('util');

// 온도 (섭씨) -> 레벨 (0-7) 매핑
const TEMP_LEVEL_MAP = { 15: 0, 20: 1, 25: 2, 30: 3, 35: 4, 40: 5, 45: 6, 50: 7 };
// 레벨 (0-7) -> 온도 (섭씨) 매핑
const LEVEL_TEMP_MAP = { 0: 15, 1: 20, 2: 25, 3: 30, 4: 35, 5: 40, 6: 45, 7: 50 };
const MIN_TEMP = 15;
const MAX_TEMP = 50;
const DEFAULT_HEAT_TEMP = 30;

// 타이머 최대 시간 (최대 15시간)
const MAX_TIMER_HOURS = 15;
// HomeKit Brightness 단위당 시간 값 (100 / 15)
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

        // 디바운스 타이머 저장을 위한 변수 (BLE 과부하 방지)
        this.setTempTimeout = null;
        // 마지막으로 설정된 Level 값을 저장하여 중복 명령 방지
        this.lastSentLevel = -1;

        this.currentState = {
            targetTemp: MIN_TEMP,
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
     * BLE 쓰기 작업 시 재시도 로직을 적용하여 안정성을 높입니다.
     */
    async safeWriteValue(characteristic, packet, maxRetries = 3, delayMs = 300) {
        if (!this.isConnected) {
            throw new Error("Device not connected.");
        }

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await characteristic.writeValue(packet);
                this.log.debug(`[BLE Write] 쓰기 성공 (시도: ${attempt}/${maxRetries}).`);

                await sleep(500);

                return true;
            } catch (error) {
                this.log.warn(`[BLE Write] 쓰기 오류 발생 (시도: ${attempt}/${maxRetries}): ${error.message}`);

                // *** [FIX 1: ATT 0x0e 오류 처리] ***
                // 치명적인 ATT 오류 발생 시 즉시 연결 해제 및 루프 종료
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
     * [확정된 패킷 구성 함수]
     * 패킷 구조: [Value (Left), Checksum (Left), Value (Right), Checksum (Right)]
     * Checksum 공식: 255 - Value
     *
     * HomeKit은 단일 제어를 위해 좌우 Value를 동일하게 설정합니다.
     */
    createControlPacket(value) {
        const dataByte = value;
        // Checksum: (0xFF - Value) & 0xFF
        const checkSum = (0xFF - dataByte) & 0xFF;

        const buffer = Buffer.alloc(4);

        // Byte 0: Left Zone Value (Level or Hours)
        buffer.writeUInt8(dataByte, 0);
        // Byte 1: Left Zone Checksum (255 - Value)
        buffer.writeUInt8(checkSum, 1);

        // Byte 2: Right Zone Value (Level or Hours)
        buffer.writeUInt8(dataByte, 2);
        // Byte 3: Right Zone Checksum (255 - Value)
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
            await this.setCharacteristic.writeValue(initPacket);

            await sleep(500);

            this.log.info('[Init] 초기화 패킷 전송 성공.');
        } catch (error) {
            this.log.error(`[Init] 초기화 패킷 전송 오류: ${error.message}`);
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
            // handleSetTargetTemperature는 디바운스를 위해 Promise를 반환하지 않으므로 await 제거
            this.handleSetTargetTemperature(MIN_TEMP);

        } else if (value === this.Characteristic.TargetHeatingCoolingState.HEAT) {
            this.log.info(`[HomeKit] 전원 ON 명령 수신. 마지막 설정 온도(${this.currentState.lastHeatTemp}°C)로 복구합니다.`);
            // handleSetTargetTemperature는 디바운스를 위해 Promise를 반환하지 않으므로 await 제거
            this.handleSetTargetTemperature(this.currentState.lastHeatTemp);
        }
    }

    /**
     * HomeKit 온도 설정 명령을 처리하며, BLE 명령 과부하를 방지하기 위해 디바운스 로직을 적용합니다.
     */
    handleSetTargetTemperature(value) {
        // 1. 목표 Level 계산
        let level = TEMP_LEVEL_MAP[Math.round(value / 5) * 5] || 0;
        if (value < MIN_TEMP) level = 0;
        if (value >= MAX_TEMP) level = 7;

        this.log.debug(`[Temp Debounce] HomeKit ${value}°C 설정 -> Level ${level}. (최종 명령 대기 중)`);

        // 2. 중복 Level 명령 방지
        if (level === this.lastSentLevel && this.currentState.targetTemp === value) {
            this.log.info(`[Temp Debounce] Level ${level}은 이미 전송된 값입니다. 명령 전송을 건너뜀니다.`);
            return;
        }

        // 3. 기존 타이머 제거
        if (this.setTempTimeout) {
            clearTimeout(this.setTempTimeout);
        }

        // 4. 350ms 지연 후 실제 명령 전송 (앱 분석 결과 반영)
        this.setTempTimeout = setTimeout(async () => {
            // *** [FIX 2: Uncaught Rejection Crash 방지] ***
            try {
                await this.sendTemperatureCommand(value, level);
            } catch (e) {
                this.log.error(`[Temp Debounce Final Error] 온도 설정 명령 처리 중 BLE 통신 오류 발생: ${e.message}. 프로세스 크래시 방지.`);
            }
        }, 350);
    }

    /**
     * 실제 BLE 온도를 전송하고 HomeKit 상태를 업데이트하는 내부 함수
     */
    async sendTemperatureCommand(value, level) {
        this.setTempTimeout = null; // 타이머 완료

        const packet = this.createControlPacket(level);
        this.log.info(`[Temp Command] Level ${level} 명령 전송 시도. **패킷:** ${packet.toString('hex')}`);

        if (this.tempCharacteristic && this.isConnected) {
            try {
                await this.safeWriteValue(this.tempCharacteristic, packet);
                this.lastSentLevel = level; // 성공 시 마지막 전송 레벨 업데이트

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

            } catch (error) {
                this.log.error(`[Temp Command] BLE 쓰기 오류: ${error.message}`);
                // 실패 시, lastSentLevel은 업데이트하지 않아 다음 시도 가능
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        } else {
            // *** [HAP Status Error: -70402] 발생 방지 로직 FIX] ***
            if (level === 0) {
                this.log.warn('[Temp Command] [Startup Skip] BLE 연결이 없어 Level 0 (OFF) 명령 전송을 건너뜁니다.');
                return; // 시작 시의 OFF 명령은 무시하고 에러를 던지지 않습니다.
            } else {
                this.log.warn('[Temp Command] BLE 연결 없음. 명령 전송 불가. (백그라운드에서 재연결 시도 중)');
                // 사용자가 HEAT 명령을 내렸을 경우에만 에러를 던져 HomeKit에 통신 실패를 알립니다.
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        }
    }


    async handleSetTimerHours(value) {
        // 1. 밝기 값으로 시간 계산
        let hours = Math.round(value / BRIGHTNESS_PER_HOUR);

        // 0% < 밝기 <= (100/15)% 일 경우 1시간으로 설정
        if (value > 0 && hours === 0) {
            hours = 1;
        }

        if (hours > MAX_TIMER_HOURS) {
            hours = MAX_TIMER_HOURS;
        }

        // 2. 0시간일 시 전원 OFF 명령을 추가합니다. (온도 15°C 설정)
        if (hours === 0) {
            this.log.info('[Timer] 타이머 0시간 설정 수신. 전원을 OFF 합니다.');
            // 디바운스 로직이 적용된 handleSetTargetTemperature 호출
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
            // 타이머 스위치 OFF 시 전원 OFF 명령을 추가합니다.
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
            // *** [HAP Status Error: -70402] 발생 방지 로직 FIX] ***
            if (hours === 0) {
                this.log.warn('[Timer] [Startup Skip] BLE 연결이 없어 타이머 0시간 (OFF) 명령 전송을 건너킵니다.');
                return; // 시작 시의 OFF 명령은 무시하고 에러를 던지지 않습니다.
            } else {
                this.log.warn('[Timer] BLE 연결 없음. 명령 전송 불가. (백그라운드에서 재연결 시도 중)');
                // 사용자가 ON 명령을 내렸을 경우에만 에러를 던져 HomeKit에 통신 실패를 알립니다.
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        }
    }

    /**
     * BLE 어댑터 및 장치 검색/연결 로직 (기존 작동 로직 유지)
     */
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

                // [주의] ATT 0x0e 오류 회피를 위해 초기화 패킷 전송은 주석 처리된 상태로 유지합니다.
                // if (this.setCharacteristic && this.initPacketHex) {
                //     this.log.warn('[Init] ATT 0x0e 오류 회피를 위해 초기화 패킷 전송을 건너뜠습니다.');
                //     // await this.sendInitializationPacket();
                //     // await sleep(1000);
                // }

                // BLE Notification/Indication 활성화 및 핸들러 구현
                try {
                    this.log.info('[BLE] 온도 및 타이머 특성 Notification 활성화 시도...');

                    // 온도 핸들러
                    await this.tempCharacteristic.startNotifications();
                    this.tempCharacteristic.on('valuechanged', (data) => {
                        this.log.debug(`[BLE Notify] 온도 데이터 수신: ${data.toString('hex')}`);

                        // *** [FIX 3: 수동 조작 동기화를 위한 인덱스 수정] ***
                        // 패킷 구조가 [Level, Checksum, Level, Checksum]이라고 가정하고 인덱스 0과 2에서 레벨을 읽습니다.
                        const levelLeft = data.readUInt8(0); // 좌측 레벨 (수정됨)
                        const levelRight = data.readUInt8(2); // 우측 레벨 (수정됨)

                        const currentLevel = Math.max(levelLeft, levelRight);
                        const newTemp = LEVEL_TEMP_MAP[currentLevel] || MIN_TEMP;

                        // Notification 수신 시 lastSentLevel도 업데이트하여 상태 동기화
                        this.lastSentLevel = currentLevel;

                        // --- 수동 조작 시 Target/Current 상태 동기화 로직 ---

                        // 1. Target Temperature 업데이트 (수동 조작된 온도가 새로운 목표 온도가 됩니다)
                        if (this.currentState.targetTemp !== newTemp) {
                            this.currentState.targetTemp = newTemp;
                            this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, newTemp);
                            this.log.info(`[Notify] Target 온도 업데이트 (수동 조작): ${newTemp}°C`);
                        }

                        // 2. Heating/Cooling State 업데이트
                        const newTargetState = currentLevel > 0
                            ? this.Characteristic.TargetHeatingCoolingState.HEAT
                            : this.Characteristic.TargetHeatingCoolingState.OFF;

                        const newCurrentState = currentLevel > 0
                            ? this.Characteristic.CurrentHeatingCoolingState.HEAT
                            : this.Characteristic.CurrentHeatingCoolingState.OFF;

                        if (this.currentState.currentHeatingCoolingState !== newCurrentState) {
                            this.currentState.currentHeatingCoolingState = newCurrentState;
                            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, newCurrentState);
                            this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, newTargetState);
                            this.log.info(`[Notify] 전원 상태 업데이트 (수동 조작): ${newCurrentState === this.Characteristic.CurrentHeatingCoolingState.HEAT ? 'HEAT' : 'OFF'}`);
                        }

                        // 3. Current Temperature 업데이트 (측정 온도)
                        if (this.currentState.currentTemp !== newTemp) {
                            this.currentState.currentTemp = newTemp;
                            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, newTemp);
                            this.log.info(`[Notify] 실시간 Current 온도 업데이트: ${newTemp}°C`);
                        }

                        // 4. lastHeatTemp 업데이트
                        if (currentLevel > 0) {
                            this.currentState.lastHeatTemp = newTemp;
                        }
                        // --- 수동 조작 시 Target/Current 상태 동기화 로직 끝 ---
                    });

                    // 타이머 핸들러
                    await this.timeCharacteristic.startNotifications();
                    this.timeCharacteristic.on('valuechanged', (data) => {
                        this.log.debug(`[BLE Notify] 타이머 데이터 수신: ${data.toString('hex')}`);

                        // 좌/우 중 최대 시간을 현재 상태로 반영 (시간은 명령/알림 패킷 구조가 동일할 가능성이 높음)
                        const currentHoursLeft = data.readUInt8(0);
                        const currentHoursRight = data.readUInt8(2);
                        const currentHours = Math.max(currentHoursLeft, currentHoursRight);

                        if (this.currentState.timerHours !== currentHours) {
                            this.currentState.timerHours = currentHours;
                            this.currentState.timerOn = currentHours > 0;

                            this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
                            this.timerService.updateCharacteristic(this.Characteristic.Brightness, currentHours * BRIGHTNESS_PER_HOUR);
                            this.log.info(`[Notify] 실시간 타이머 업데이트: ${currentHours}시간`);
                        }
                    });

                    this.log.info('[BLE] Notification 활성화 성공.');

                } catch (e) {
                    this.log.error(`[BLE Notify] Notification 활성화 실패: ${e.message}. 연결 안정성이 저하될 수 있습니다.`);
                }

                await sleep(500);

                await this.readCurrentState();
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

    async readCurrentState() {
        try {
            // 온도 상태 동기화: 좌우 중 최대 레벨 반영
            const tempValue = await this.tempCharacteristic.readValue();
            // 초기 READ 시에도 인덱스 0과 2를 사용하여 레벨을 읽도록 수정
            const levelLeft = tempValue.readUInt8(0);
            const levelRight = tempValue.readUInt8(2);
            const currentLevel = Math.max(levelLeft, levelRight);

            const currentTemp = LEVEL_TEMP_MAP[currentLevel] || MIN_TEMP;

            // 초기 상태 동기화 시 lastSentLevel도 업데이트
            this.lastSentLevel = currentLevel;

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

            this.log.debug(`[Sync] 온도 상태 동기화 완료: Level ${currentLevel} -> ${currentTemp}°C. (좌우 중 최대 레벨 반영)`);

            // 타이머 상태 동기화: 좌우 중 최대 시간 반영
            const timeValue = await this.timeCharacteristic.readValue();
            // 초기 READ 시에도 인덱스 0과 2를 사용하여 시간을 읽도록 수정
            const currentHoursLeft = timeValue.readUInt8(0);
            const currentHoursRight = timeValue.readUInt8(2);
            const currentHours = Math.max(currentHoursLeft, currentHoursRight);


            this.currentState.timerHours = currentHours;
            this.currentState.timerOn = currentHours > 0;

            this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
            this.timerService.updateCharacteristic(this.Characteristic.Brightness, currentHours * BRIGHTNESS_PER_HOUR);

            this.log.debug(`[Sync] 타이머 상태 동기화 완료: ${currentHours} 시간. (좌우 중 최대 시간 반영)`);

        } catch (error) {
            this.log.warn(`[Sync] 초기 상태 읽기 실패 (READ 속성이 없거나 데이터 해석 오류): ${error.message}`);
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
