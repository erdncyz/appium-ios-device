
import { LengthBasedSplitter } from '../util/transformer/length-based-splitter';
import { Operations, operationCode, Errors, errorCode, FileModes } from './protocol';
import { AfcWritableFileStream, AfcReadableFileStream } from './streams';
import { AfcEncoder } from './transformer/afcencoder';
import { AfcDecoder } from './transformer/afcdecoder';
import { MB } from '../constants';
import B from 'bluebird';
import path from 'path';
import _ from 'lodash';
import { BaseServiceSocket } from '../base-service';


const AFC_SERVICE_NAME = 'com.apple.afc';
const MAX_FRAME_SIZE = 1 * MB;

// Get maxFrameLength from environment variable or use default
const getMaxFrameLength = () => {
  const envValue = process.env.APPIUM_IOS_MAX_FRAME_SIZE;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return MAX_FRAME_SIZE;
};

const NULL_DELIMITER_CODE = 0x00;
const IGNORED_PATHS = ['.', '..'];

class AfcService extends BaseServiceSocket {
  constructor (socketClient) {
    super(socketClient);

    this._splitter = new LengthBasedSplitter({
      readableStream: socketClient,
      littleEndian: true,
      maxFrameLength: getMaxFrameLength(),
      lengthFieldOffset: 8,
      lengthFieldLength: 8,
      lengthAdjustment: -8,
      serviceName: 'AFC',
    });
    this._decoder = new AfcDecoder();
    this._socketClient.pipe(this._splitter).pipe(this._decoder);

    this._encoder = new AfcEncoder();
    this._encoder.pipe(this._socketClient);
    this._assignClientFailureHandlers(this._encoder);

    this._responseCallbacks = {};

    this._packetNumber = 0;
    this._decoder.on('data', this._handleData.bind(this));
  }

  _handleData (data) {
    const cb = this._responseCallbacks[data.packetNumber] || _.noop;
    cb(data); // eslint-disable-line promise/prefer-await-to-callbacks
  }

  /**
   * Creates a directory relative to an already existing directory
   * @param {string} path The path in unix format
   */
  async createDirectory (path) {
    const {packetNumber, response} = this._createPacketPromise(`Create directory '${path}'`);

    const data = {
      opCode: Operations.MAKE_DIR,
      packetNumber,
      headerPayload: Buffer.from(path)
    };
    this._encoder.write(data);
    const res = await response;
    this._checkStatus(res);
  }

  /**
   * Deletes are directory completely even it has content inside. This is an implementation of 'rm -r {path}'
   * @param {string} path The path in unix format
   */
  async deleteDirectory (path) {
    const {packetNumber, response} = this._createPacketPromise(`Delete directory '${path}'`);

    const data = {
      opCode: Operations.REMOVE_PATH_AND_CONTENTS,
      packetNumber,
      headerPayload: Buffer.from(path)
    };
    this._encoder.write(data);
    const res = await response;
    this._checkStatus(res);
  }

  /**
   * Lists a directory's contents and returns them in an array
   * @param {string} path The path in unix format
   * @return {Promise<string[]>}
   */
  async listDirectory (path) {
    const {packetNumber, response} = this._createPacketPromise(`List directory '${path}'`);

    const data = {
      opCode: Operations.READ_DIR,
      packetNumber,
      headerPayload: Buffer.from(path)
    };
    this._encoder.write(data);
    const res = await response;
    if (res.opCode !== Operations.DATA) {
      this._checkStatus(res);
    }

    return this._parseArray(res.content);
  }

  /**
   * Opens a file and creates a file handle
   * @param {string} path The path in unix format
   * @param {number} mode The file mode that will be used
   * @return {Promise<number>}
   */
  async openFile (path, mode) {
    const {packetNumber, response} = this._createPacketPromise(`Open file '${path}'`);

    const pathPayload = Buffer.from(path);
    const fileModePayload = Buffer.alloc(8);
    fileModePayload.writeUInt32LE(mode, 0);

    const data = {
      opCode: Operations.FILE_OPEN,
      packetNumber,
      headerPayload: Buffer.concat([fileModePayload, pathPayload])
    };
    this._encoder.write(data);
    const res = await response;
    if (res.opCode !== Operations.FILE_OPEN_RES) {
      this._checkStatus(res);
    }

    return res.headerPayload.readUInt32LE(0);
  }

  /**
   * Opens a file and creates a nodejs write stream
   * @param {string} filePath The path in unix format
   * @param {Object} opts The regular options that are passed to a Stream.Writable
   * @return {Promise<AfcWritableFileStream>}
   */
  async createWriteStream (filePath, opts) {
    const fileHandle = await this.openFile(filePath, FileModes.w);
    return new AfcWritableFileStream(fileHandle, this, opts);
  }

  /**
   * Opens a file and creates a nodejs read stream
   * @param {string} filePath The path in unix format
   * @param {Object} options The regular options that are passed to a Stream.Readable
   * @return {Promise<AfcReadableFileStream>}
   */
  async createReadStream (filePath, options) {
    const fileHandle = await this.openFile(filePath, FileModes.r);
    return new AfcReadableFileStream(fileHandle, this, options);
  }

  /**
   * Closes the file handle
   * @param {number} fileHandle the file handle to be closed
   */
  async closeFileHandle (fileHandle) {
    const {packetNumber, response} = this._createPacketPromise(`Close file handle '${fileHandle}'`);

    const fileModePayload = Buffer.alloc(8);
    fileModePayload.writeUInt32LE(fileHandle, 0);

    const data = {
      opCode: Operations.FILE_CLOSE,
      packetNumber,
      headerPayload: fileModePayload
    };
    this._encoder.write(data);
    const res = await response;
    this._checkStatus(res);
  }

  /**
   * Writes the buffer into the given file handle
   * @param {number} fileHandle The file handle to be used
   * @param {Buffer} buffer The buffer that will be written
   */
  async writeFile (fileHandle, buffer) {
    const {packetNumber, response} = this._createPacketPromise(`Write to file handle '${fileHandle}'`);

    const headerPayload = Buffer.alloc(8);
    headerPayload.writeUInt32LE(fileHandle, 0);

    const data = {
      opCode: Operations.FILE_WRITE,
      packetNumber,
      headerPayload,
      content: buffer
    };
    this._encoder.write(data);
    const res = await response;
    this._checkStatus(res);
  }

  /**
   * Read a certain length of buffer from the file handle
   * @param {number} fileHandle The file handle to be used
   * @param {number} length The length that wants to be read from the file handle
   * @return {Promise<Buffer>}
   */
  async readFile (fileHandle, length) {
    const {packetNumber, response} = this._createPacketPromise(`Read from file handle '${fileHandle}'`);

    const headerPayload = Buffer.alloc(16);
    headerPayload.writeUInt32LE(fileHandle, 0);
    headerPayload.writeUInt32LE(length, 8);

    const data = {
      opCode: Operations.FILE_READ,
      packetNumber,
      headerPayload
    };
    this._encoder.write(data);
    const res = await response;
    if (res.opCode !== Operations.DATA) {
      this._checkStatus(res);
    }
    return res.content;
  }

  /**
   * Get the file info of the given path
   * @param {string} path The path in unix format
   * @return {Promise<FileInfo>}
   */
  async getFileInfo (path) {
    const {packetNumber, response} = this._createPacketPromise(`Get file info '${path}'`);

    const data = {
      opCode: Operations.GET_FILE_INFO,
      packetNumber,
      headerPayload: Buffer.from(path)
    };
    this._encoder.write(data);
    const res = await response;
    if (res.opCode !== Operations.DATA) {
      this._checkStatus(res);
    }
    // @ts-ignore this should be ok
    return new FileInfo(this._parseObject(res.content));
  }

  /** The callback function which will be called during the directory walking
   * @callback WalkDirCallback
   * @param {string} itemPath The path of the file or folder
   * @param {boolean} isDirectory Shows if it is a directory or a file
  */

  /**
   *
   * @param {string} dir The path in unix format
   * @param {boolean} recursive Sets whether to follow sub directories or not
   * @param {WalkDirCallback} onPath The callback to be called when a new path is found
   */
  async walkDir (dir, recursive, onPath) {
    for (const file of await this.listDirectory(dir)) {
      if (IGNORED_PATHS.includes(file)) {
        continue;
      }
      const relativePath = path.posix.join(dir, file);
      const fileInfo = await this.getFileInfo(relativePath);
      const isDirectory = fileInfo.isDirectory();
      await onPath(relativePath, isDirectory);
      if (isDirectory && recursive) {
        await this.walkDir(relativePath, recursive, onPath);
      }
    }
  }

  _checkStatus (res) {
    if (res.opCode !== Operations.STATUS) {
      throw new Error(`Unexpected response ${operationCode(res.opCode)}`);
    }
    if (_.isEmpty(res.headerPayload)) {
      throw new Error('Header payload cannot be empty for a status response');
    }
    if (res.headerPayload[0] !== Errors.SUCCESS) {
      throw new Error(`Unexpected response ${errorCode(res.headerPayload[0])}`);
    }
  }

  _parseArray (buffer) {
    const items = [];
    let start = 0;
    for (let end = 0; end < buffer.length; end++) {
      if (buffer[end] !== NULL_DELIMITER_CODE) {
        continue;
      }
      const item = buffer.toString('utf8', start, end);
      items.push(item);
      // We skip the null delimiter
      start = end + 1;
    }
    return items;
  }

  _parseObject (buffer) {
    const items = {};
    let start = 0;
    let currentKey;
    for (let end = 0; end < buffer.length; end++) {
      if (buffer[end] !== NULL_DELIMITER_CODE) {
        continue;
      }
      const item = buffer.toString('utf8', start, end);
      if (_.isNil(currentKey)) {
        currentKey = item;
      } else {
        items[currentKey] = item;
        currentKey = null;
      }
      // We skip the null delimiter
      start = end + 1;
    }
    if (currentKey) {
      throw new Error(`Failed to parse correctly ${buffer}. Please investigate`);
    }
    return items;
  }

  _createPacketPromise (message, timeout = 10000) {
    const packetNumber = this._packetNumber++;
    const response = new B((resolve, reject) => {
      this._responseCallbacks[packetNumber] = resolve;
      setTimeout(function () {
        reject(new Error(`Could not finish the operation '${message}'. Failed to receive any data within the ${timeout}ms timeout`));
      }, timeout);
    });
    return {packetNumber, response};
  }
}

class FileInfo {
  constructor ({st_size, st_blocks, st_nlink, st_ifmt, st_mtime, st_birthtime}) {
    this.size = parseInt(st_size, 10);
    this.blocks = parseInt(st_blocks, 10);
    this.nlink = parseInt(st_nlink, 10);
    this.ifmt = st_ifmt;
    // ns to ms
    this.mtimeMs = parseInt(st_mtime, 10) / 1000000;
    // ns to ms
    this.birthtimeMs = parseInt(st_birthtime, 10) / 1000000;
  }

  isDirectory () {
    return this.ifmt === 'S_IFDIR';
  }

  isFile () {
    return this.ifmt === 'S_IFREG';
  }
}

export default AfcService;
export { AfcService, AFC_SERVICE_NAME };
