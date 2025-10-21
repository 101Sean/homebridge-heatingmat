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

        // 필수 설정 확인 및 정리
        this.macAddress = (config.mac_address || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        this.serviceUuid = (config.service_uuid || '').toLowerCase();
        this.charTempUuid = (config.char_temp_uuid || '').toLowerCase();
        this.charTimeUuid = (config.char_timer_uuid || '').toLowerCase();

        // 선택적 설정
        this.adapterId = config.adapter_id || 'hci0';
        this.scanInterval = (config.scan_interval_sec || 15) * 1000;
        this.charSetUuid = (config.char_set_uuid || '').toLowerCase(); // 초기화 패킷 전송용 특성
        this.initPacketHex = config.init_packet_hex; // 초기화 패킷 데이터

        if (!this.macAddress || !this.serviceUuid || !this.charTempUuid || !this.charTimeUuid) {
            this.log.error('config.json에 필수 설정(mac_address, service_uuid, char_temp_uuid, char_timer_uuid)이 누락되었습니다.');
            return;
        }

        this.name = config.name || '스마트 히팅 매트';
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.setCharacteristic = null; // 초기화 패킷용
        this.device = null;
        this.adapter = null;
        this.isConnected = false;

        this.isScanningLoopActive = false;

        // 온도 설정 디바운싱 및 상태 관리
        this.setTempTimeout = null;
        this.lastSentLevel = -1; // 마지막으로 장치에 전송한 레벨 (중복 명령 방지용)

        // BLE Read 요청을 순차적으로 처리하기 위한 큐 (BLE 통신 안정성 향상)
        this.readQueue = [];
        this.isProcessingReadQueue = false;

        // 초기 상태
        this.currentState = {
            targetTemp: DEFAULT_HEAT_TEMP,
            currentTemp: MIN_TEMP,
            currentHeatingCoolingState: this.Characteristic.CurrentHeatingCoolingState.OFF,
            timerHours: 0,
            timerOn: false,
            lastHeatTemp: DEFAULT_HEAT_TEMP // 전원이 꺼져도 마지막 온도를 기억
        };

        this.initServices();
        this.initNodeBle();
    }

    async safeWriteValue(characteristic, packet, maxRetries = 3, delayMs = 300) {
        if (!this.isConnected) {
            throw new Error("Device not connected.");
        }

        const writeOptions = { type: 'command' }; // Write Command (응답을 기다리지 않음)

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await characteristic.writeValue(packet, writeOptions);
                this.log.debug(`[BLE Write] 쓰기 성공 (시도: ${attempt}/${maxRetries}, Type: Command).`);

                await sleep(500); // 명령 전송 후 안정화 딜레이

                return true;
            } catch (error) {
                this.log.warn(`[BLE Write] 쓰기 오류 발생 (시도: ${attempt}/${maxRetries}, Type: Command): ${error.message}`);

                // 치명적인 ATT 오류(0x0e) 발생 시 즉시 연결 해제
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
        const checkSum = (0xFF - dataByte) & 0xFF; // 1의 보수 + 1 (2의 보수는 0xFF 대신 0x100 - dataByte를 사용)

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

            // 초기화 패킷도 Write Command로 전송
            await this.setCharacteristic.writeValue(initPacket, { type: 'command' });

            await sleep(500);

            this.log.info('[Init] 초기화 패킷 전송 성공.');
        } catch (error) {
            this.log.error(`[Init] 초기화 패킷 전송 오류: ${error.message}`);
            this.disconnectDevice(true);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    enqueueRead(characteristic) {
        if (!characteristic || !this.isConnected) {
            this.log.warn(`[Read Queue] Read request for ${characteristic?.uuid} skipped (Characteristic missing or disconnected).`);
            return;
        }

        this.readQueue.push(characteristic);
        if (!this.isProcessingReadQueue) {
            this.processReadQueue();
        }
    }

    async processReadQueue() {
        if (this.readQueue.length === 0) {
            this.isProcessingReadQueue = false;
            this.log.debug("[Read Queue] 큐 처리 완료.");
            return;
        }

        this.isProcessingReadQueue = true;
        const characteristic = this.readQueue.shift();

        try {
            this.log.debug(`[Read Queue] Reading characteristic: ${characteristic.uuid}`);
            const buffer = await characteristic.readValue();
            this.log.info(`[Read Queue] Read successful from ${characteristic.uuid}. Value: ${buffer.toString('hex')}`);

            // Notification 핸들러와 동일한 함수를 사용하여 상태 업데이트
            this.handleTemperatureNotification(buffer, characteristic.uuid);

        } catch (error) {
            this.log.error(`[Read Queue] Error reading characteristic ${characteristic.uuid}: ${error.message}`);
            // 읽기 실패 시 연결 해제 없이 다음 큐 항목을 처리
        }

        // 다음 항목을 위해 짧은 딜레이 후 처리
        await sleep(250);
        this.processReadQueue();
    }

    handleTemperatureNotification(buffer, uuid) {
        if (buffer.length === 0) {
            this.log.warn(`[Sync] Received empty buffer from UUID ${uuid}. Skipping update.`);
            return;
        }

        // 장치는 단일 바이트 (온도 레벨 또는 시간)를 사용합니다.
        const valueByte = buffer.readUInt8(0);

        if (uuid === this.charTempUuid) {
            // 온도/전원 특성
            const level = valueByte;
            const temp = LEVEL_TEMP_MAP[level] || MIN_TEMP;

            this.currentState.targetTemp = temp;
            this.currentState.currentTemp = temp;
            this.currentState.currentHeatingCoolingState =
                level > 0 ? this.Characteristic.CurrentHeatingCoolingState.HEAT : this.Characteristic.CurrentHeatingCoolingState.OFF;

            if (level > 0) {
                this.currentState.lastHeatTemp = temp;
            }
            this.lastSentLevel = level; // 동기화된 레벨로 lastSentLevel 업데이트 (중복 명령 방지)

            this.log.info(`[Sync Temp] 장치 상태 동기화: Level ${level} -> ${temp}°C. Heating State: ${this.currentState.currentHeatingCoolingState}`);

            // HomeKit 업데이트
            this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, temp);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, temp);
            this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.currentState.currentHeatingCoolingState);
            this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.currentState.currentHeatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.OFF
                ? this.Characteristic.TargetHeatingCoolingState.OFF
                : this.Characteristic.TargetHeatingCoolingState.HEAT);


        } else if (uuid === this.charTimeUuid) {
            // 타이머 특성
            const hours = valueByte;
            this.currentState.timerHours = hours;
            this.currentState.timerOn = hours > 0;
            const brightness = hours * BRIGHTNESS_PER_HOUR;

            this.log.info(`[Sync Timer] 장치 상태 동기화: ${hours} 시간 -> Brightness ${brightness}%`);

            // HomeKit 업데이트
            this.timerService.updateCharacteristic(this.Characteristic.On, this.currentState.timerOn);
            this.timerService.updateCharacteristic(this.Characteristic.Brightness, brightness);

        } else {
            this.log.warn(`[Sync] Unknown UUID ${uuid} received. Skipping.`);
        }
    }

    async readCurrentState() {
        if (!this.isConnected || !this.tempCharacteristic || !this.timeCharacteristic) {
            this.log.warn('[Sync] 현재 상태 동기화 실패: 장치 연결 또는 특성 준비 미완료.');
            return;
        }
        this.log.info('[Sync] 장치의 현재 온도 및 타이머 상태 동기화를 시작합니다 (Read Queue 사용).');

        // Read 요청을 큐에 추가하여 순차적으로 처리
        this.enqueueRead(this.tempCharacteristic);
        this.enqueueRead(this.timeCharacteristic);
    }

    initServices() {
        this.accessoryInformation = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'Generic Mat')
            .setCharacteristic(this.Characteristic.Model, 'BLE Heating Mat')
            .setCharacteristic(this.Characteristic.SerialNumber, this.macAddress);

        this.thermostatService = new this.Service.Thermostat(this.name + ' 온도');

        // TargetTemperature (목표 온도)
        this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 5 }) // 5도 단위 제어
            .onSet(this.handleSetTargetTemperature.bind(this))
            .onGet(() => this.currentState.targetTemp);

        // CurrentTemperature (현재 온도 - 목표 온도로 간주)
        this.thermostatService.getCharacteristic(this.Characteristic.CurrentTemperature)
            .setProps({ minValue: MIN_TEMP, maxValue: MAX_TEMP, minStep: 1 })
            .onGet(() => this.currentState.currentTemp);

        // TargetHeatingCoolingState (전원 On/Off 제어)
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

        // CurrentHeatingCoolingState (현재 상태)
        this.thermostatService.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(() => this.currentState.currentHeatingCoolingState);

        this.thermostatService.setCharacteristic(this.Characteristic.TemperatureDisplayUnits, this.Characteristic.TemperatureDisplayUnits.CELSIUS);

        // 타이머 서비스 (Lightbulb로 구현 - On/Brightness 사용)
        this.timerService = new this.Service.Lightbulb(this.name + ' 타이머 설정');

        this.timerService.getCharacteristic(this.Characteristic.On)
            .onSet(this.handleTimerSwitch.bind(this))
            .onGet(() => this.currentState.timerOn);

        // Brightness (타이머 시간 설정)
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
        // 5의 배수로 반올림 후 맵에서 Level 찾기.
        let level = TEMP_LEVEL_MAP[Math.round(value / 5) * 5] || 0;
        if (value < MIN_TEMP) level = 0; // 15도 미만은 OFF (Level 0)
        if (value >= MAX_TEMP) level = 7; // 50도 이상은 MAX (Level 7)

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

        // 4. 350ms 지연 후 실제 명령 전송 (앱 분석 결과: 디바운싱 시간)
        this.setTempTimeout = setTimeout(async () => {
            try {
                await this.sendTemperatureCommand(value, level);
            } catch (e) {
                this.log.error(`[Temp Debounce Final Error] 온도 설정 명령 처리 중 BLE 통신 오류 발생: ${e.message}.`);
                // HomeKit 에러 상태를 설정 (재연결 루프가 백그라운드에서 실행됨)
                this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
                    .updateCharacteristic(new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
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
                const actualTemp = LEVEL_TEMP_MAP[level];

                this.currentState.targetTemp = value;
                this.currentState.currentTemp = actualTemp;
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
        // 1. 밝기 값으로 시간 계산 (가장 가까운 시간으로 반올림)
        let hours = Math.round(value / BRIGHTNESS_PER_HOUR);

        if (value > 0 && hours === 0) {
            hours = 1; // 0이 아닌 Brightness를 받았을 때 최소 1시간 설정
        }

        if (hours > MAX_TIMER_HOURS) {
            hours = MAX_TIMER_HOURS;
        }

        // 2. 0시간일 시 전원 OFF 명령을 추가 (앱 동작 분석 결과 반영)
        if (hours === 0) {
            this.log.info('[Timer] 타이머 0시간 설정 수신. 전원을 OFF 합니다.');
            // 디바운스 로직이 적용된 handleSetTargetTemperature 호출
            this.handleSetTargetTemperature(MIN_TEMP);
        }

        // 3. 타이머 명령 전송
        try {
            await this.sendTimerCommand(hours);
        } catch (error) {
            this.log.error(`[Timer] 타이머 명령 전송 중 오류 발생: ${error.message}`);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }

        // 4. HomeKit 상태 업데이트 (성공 시)
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
            this.log.info('[Timer] HomeKit 스위치 OFF. 타이머 해제 (0시간) 및 전원 OFF.');
            // 전원 OFF 명령도 함께 전송
            this.handleSetTargetTemperature(MIN_TEMP);

        } else {
            // 스위치 ON 시, 현재 Brightness 값에 해당하는 시간을 재설정
            let currentBrightness = this.timerService.getCharacteristic(this.Characteristic.Brightness).value;
            hoursToSend = Math.round(currentBrightness / BRIGHTNESS_PER_HOUR);

            if (hoursToSend === 0) {
                // Brightness가 0일 경우 최소 1시간으로 설정
                hoursToSend = 1;
                brightnessToSet = BRIGHTNESS_PER_HOUR;
                this.log.info('[Timer] HomeKit 스위치 ON. 시간이 0이므로 1시간으로 설정.');
            } else {
                brightnessToSet = hoursToSend * BRIGHTNESS_PER_HOUR;
                this.log.info(`[Timer] HomeKit 스위치 ON. ${hoursToSend}시간으로 재설정.`);
            }
        }

        try {
            await this.sendTimerCommand(hoursToSend);
        } catch (error) {
            this.log.error(`[Timer] 타이머 스위치 명령 전송 중 오류 발생: ${error.message}`);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }

        // HomeKit 상태 업데이트 (성공 시)
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
                this.log.warn('[Timer] [Startup Skip] BLE 연결이 없어 타이머 0시간 (OFF) 명령 전송을 건너뜁니다.');
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

                    // 스캔 시간 (노드블루의 기본값은 5초)
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
                            this.log.debug(`[BLE] 매트 장치(${targetAddress})를 찾지 못했습니다.`);
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

                // 1. Notification 구독 설정 (장치 상태 실시간 동기화)
                this.log.info('[BLE] Notification 구독 시작.');

                // --- 온도 특성 Notification 구독 ---
                await this.tempCharacteristic.startNotifications();
                this.tempCharacteristic.on('valuechanged', (buffer) => {
                    this.log.info(`[NOTI TEMP] 값 변경 감지: ${buffer.toString('hex')}`);
                    this.handleTemperatureNotification(buffer, this.charTempUuid);
                });
                this.log.debug('[BLE] 온도 특성 Notification 구독 완료.');

                // --- 타이머 특성 Notification 구독 ---
                await this.timeCharacteristic.startNotifications();
                this.timeCharacteristic.on('valuechanged', (buffer) => {
                    this.log.info(`[NOTI TIME] 값 변경 감지: ${buffer.toString('hex')}`);
                    this.handleTemperatureNotification(buffer, this.charTimeUuid);
                });
                this.log.debug('[BLE] 타이머 특성 Notification 구독 완료.');


                // 2. 초기화 패킷 전송
                if (this.setCharacteristic) {
                    await this.sendInitializationPacket();
                }

                // 3. 초기 연결 시 장치 상태를 HomeKit에 동기화 (Read Queue 방식)
                await this.readCurrentState();

            } else {
                this.log.error(`[BLE] 필수 특성 중 하나를 찾을 수 없습니다. (온도: ${!!this.tempCharacteristic}, 타이머: ${!!this.timeCharacteristic}) 연결 해제.`);
                this.disconnectDevice(true);
            }
        } catch (error) {
            this.log.error(`[BLE] 특성 탐색 또는 Notification 설정 오류: ${error.message}.`);
            this.log.error('[BLE] config.json에 서비스 UUID와 특성 UUID를 전체 128비트 형식으로 정확히 입력했는지 확인해 주세요.');
            this.disconnectDevice(true);
        }
    }

    disconnectDevice(resetDevice = false) {
        const deviceToDisconnect = this.device;

        // 상태 초기화
        this.isConnected = false;
        this.tempCharacteristic = null;
        this.timeCharacteristic = null;
        this.setCharacteristic = null;
        this.readQueue = []; // 큐 초기화
        this.isProcessingReadQueue = false;

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
