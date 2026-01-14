const HeatingMatAccessory = require('./lib/HeatingMatAccessory');

class HeatingMatPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;

        this.api.on('didFinishLaunching', () => {
            this.config.devices.forEach(deviceConfig => {
                this.log.info(`액세서리 로드 중: ${deviceConfig.name}`);
                new HeatingMatAccessory(this.log, deviceConfig, this.api);
            });
        });
    }
}

module.exports = (api) => {
    api.registerPlatform('homebridge-heatingmat', 'Heating Mat Platform', HeatingMatPlatform);
};