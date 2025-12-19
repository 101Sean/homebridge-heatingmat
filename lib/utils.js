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
    if (buffer.length < 4) return 0;
    const dataByte = buffer.readUInt8(0);
    const checkSum = buffer.readUInt8(1);
    if (checkSum !== (0xFF - dataByte) & 0xFF) {
        return 0; // 오류
    }
    return dataByte;
}

module.exports = {
    sleep,
    createControlPacket,
    parsePacket,
};