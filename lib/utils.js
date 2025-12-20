const { promisify } = require('util');
const sleep = promisify(setTimeout);

function createControlPacket(value) {
    const dataByte = value;
    const checkSum = (0xFF - dataByte) & 0xFF;
    const buffer = Buffer.alloc(4);
    buffer.writeUInt8(dataByte, 0);
    buffer.writeUInt8(checkSum, 1);
    buffer.writeUInt8(dataByte, 2);
    buffer.writeUInt8(checkSum, 3);
    return buffer;
}

function parsePacket(buffer) {
    if (!buffer || buffer.length < 4) {
        if (buffer.length >= 1) {
            const val = buffer.readUInt8(0);
            return (val > 12 && val < 255) ? (255 - val) : val;
        }
        return 255;
    }
    const currentVal = buffer.readUInt8(1);
    const targetVal = buffer.readUInt8(3);

    console.log(`[Debug] Current: ${currentVal}, Target: ${targetVal}`);

    return targetVal;
}

module.exports = {
    sleep,
    createControlPacket,
    parsePacket,
};