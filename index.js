const HeatingMatAccessory = require('./lib/HeatingMatAccessory');

class HeatingMatPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config || {};
        this.api = api;

        if (!this.config.devices || !Array.isArray(this.config.devices)) {
            return;
        }

        this.api.on('didFinishLaunching', () => {
            this.config.devices.forEach(deviceConfig => {
                try {
                    this.log.info(`기기 등록 시도: ${deviceConfig.name}`);

                    const accessoryInstance = new HeatingMatAccessory(this.log, deviceConfig, this.api);

                    this.api.publishExternalAccessories('homebridge-heatingmat', [
                        {
                            category: this.api.hap.Categories.THERMOSTAT,
                            external: true,
                            services: accessoryInstance.getServices(),
                            displayName: deviceConfig.name || 'Heating Mat'
                        }
                    ]);
                } catch (err) {
                    this.log.error(`기기 등록 중 오류 발생: ${err.message}`);
                }
            });
        });
    }
}

module.exports = (api) => {
    api.registerPlatform('homebridge-heatingmat', 'Heating Mat Platform', HeatingMatPlatform);
};