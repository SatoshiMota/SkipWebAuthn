// Ключ "webauthn_credentials" для использования позже нужно сохранять из текущего сайта LocalStorage (ну это для эмитации того что делает windwos hello хранит этот ключ годами)

(function(global, undefined) { "use strict";
var POW_2_24 = Math.pow(2, -24),
    POW_2_32 = Math.pow(2, 32),
    POW_2_53 = Math.pow(2, 53);

function encode(value) {
  var data = new ArrayBuffer(256);
  var dataView = new DataView(data);
  var lastLength;
  var offset = 0;

  function ensureSpace(length) {
    var newByteLength = data.byteLength;
    var requiredLength = offset + length;
    while (newByteLength < requiredLength)
      newByteLength *= 2;
    if (newByteLength !== data.byteLength) {
      var oldDataView = dataView;
      data = new ArrayBuffer(newByteLength);
      dataView = new DataView(data);
      var uint32count = (offset + 3) >> 2;
      for (var i = 0; i < uint32count; ++i)
        dataView.setUint32(i * 4, oldDataView.getUint32(i * 4));
    }

    lastLength = length;
    return dataView;
  }
  function write() {
    offset += lastLength;
  }
  function writeFloat64(value) {
    write(ensureSpace(8).setFloat64(offset, value));
  }
  function writeUint8(value) {
    write(ensureSpace(1).setUint8(offset, value));
  }
  function writeUint8Array(value) {
    var dataView = ensureSpace(value.length);
    for (var i = 0; i < value.length; ++i)
      dataView.setUint8(offset + i, value[i]);
    write();
  }
  function writeUint16(value) {
    write(ensureSpace(2).setUint16(offset, value));
  }
  function writeUint32(value) {
    write(ensureSpace(4).setUint32(offset, value));
  }
  function writeUint64(value) {
    var low = value % POW_2_32;
    var high = (value - low) / POW_2_32;
    var dataView = ensureSpace(8);
    dataView.setUint32(offset, high);
    dataView.setUint32(offset + 4, low);
    write();
  }
  function writeTypeAndLength(type, length) {
    if (length < 24) {
      writeUint8(type << 5 | length);
    } else if (length < 0x100) {
      writeUint8(type << 5 | 24);
      writeUint8(length);
    } else if (length < 0x10000) {
      writeUint8(type << 5 | 25);
      writeUint16(length);
    } else if (length < 0x100000000) {
      writeUint8(type << 5 | 26);
      writeUint32(length);
    } else {
      writeUint8(type << 5 | 27);
      writeUint64(length);
    }
  }
  
  function encodeItem(value) {
    var i;

    if (value === false)
      return writeUint8(0xf4);
    if (value === true)
      return writeUint8(0xf5);
    if (value === null)
      return writeUint8(0xf6);
    if (value === undefined)
      return writeUint8(0xf7);
  
    switch (typeof value) {
      case "number":
        if (Math.floor(value) === value) {
          if (0 <= value && value <= POW_2_53)
            return writeTypeAndLength(0, value);
          if (-POW_2_53 <= value && value < 0)
            return writeTypeAndLength(1, -(value + 1));
        }
        writeUint8(0xfb);
        return writeFloat64(value);

      case "string":
        var utf8data = [];
        for (i = 0; i < value.length; ++i) {
          var charCode = value.charCodeAt(i);
          if (charCode < 0x80) {
            utf8data.push(charCode);
          } else if (charCode < 0x800) {
            utf8data.push(0xc0 | charCode >> 6);
            utf8data.push(0x80 | charCode & 0x3f);
          } else if (charCode < 0xd800) {
            utf8data.push(0xe0 | charCode >> 12);
            utf8data.push(0x80 | (charCode >> 6)  & 0x3f);
            utf8data.push(0x80 | charCode & 0x3f);
          } else {
            charCode = (charCode & 0x3ff) << 10;
            charCode |= value.charCodeAt(++i) & 0x3ff;
            charCode += 0x10000;

            utf8data.push(0xf0 | charCode >> 18);
            utf8data.push(0x80 | (charCode >> 12)  & 0x3f);
            utf8data.push(0x80 | (charCode >> 6)  & 0x3f);
            utf8data.push(0x80 | charCode & 0x3f);
          }
        }

        writeTypeAndLength(3, utf8data.length);
        return writeUint8Array(utf8data);

      default:
        var length;
        if (Array.isArray(value)) {
          length = value.length;
          writeTypeAndLength(4, length);
          for (i = 0; i < length; ++i)
            encodeItem(value[i]);
        } else if (value instanceof Uint8Array) {
          writeTypeAndLength(2, value.length);
          writeUint8Array(value);
        } else {
          var keys = Object.keys(value);
          length = keys.length;
          writeTypeAndLength(5, length);
          for (i = 0; i < length; ++i) {
            var key = keys[i];
            encodeItem(key);
            encodeItem(value[key]);
          }
        }
    }
  }
  
  encodeItem(value);

  if ("slice" in data)
    return data.slice(0, offset);
  
  var ret = new ArrayBuffer(offset);
  var retView = new DataView(ret);
  for (var i = 0; i < offset; ++i)
    retView.setUint8(i, dataView.getUint8(i));
  return ret;
}

function decode(data, tagger, simpleValue) {
  var dataView = new DataView(data);
  var offset = 0;
  
  if (typeof tagger !== "function")
    tagger = function(value) { return value; };
  if (typeof simpleValue !== "function")
    simpleValue = function() { return undefined; };

  function read(value, length) {
    offset += length;
    return value;
  }
  function readArrayBuffer(length) {
    return read(new Uint8Array(data, offset, length), length);
  }
  function readFloat16() {
    var tempArrayBuffer = new ArrayBuffer(4);
    var tempDataView = new DataView(tempArrayBuffer);
    var value = readUint16();

    var sign = value & 0x8000;
    var exponent = value & 0x7c00;
    var fraction = value & 0x03ff;
    
    if (exponent === 0x7c00)
      exponent = 0xff << 10;
    else if (exponent !== 0)
      exponent += (127 - 15) << 10;
    else if (fraction !== 0)
      return fraction * POW_2_24;
    
    tempDataView.setUint32(0, sign << 16 | exponent << 13 | fraction << 13);
    return tempDataView.getFloat32(0);
  }
  function readFloat32() {
    return read(dataView.getFloat32(offset), 4);
  }
  function readFloat64() {
    return read(dataView.getFloat64(offset), 8);
  }
  function readUint8() {
    return read(dataView.getUint8(offset), 1);
  }
  function readUint16() {
    return read(dataView.getUint16(offset), 2);
  }
  function readUint32() {
    return read(dataView.getUint32(offset), 4);
  }
  function readUint64() {
    return readUint32() * POW_2_32 + readUint32();
  }
  function readBreak() {
    if (dataView.getUint8(offset) !== 0xff)
      return false;
    offset += 1;
    return true;
  }
  function readLength(additionalInformation) {
    if (additionalInformation < 24)
      return additionalInformation;
    if (additionalInformation === 24)
      return readUint8();
    if (additionalInformation === 25)
      return readUint16();
    if (additionalInformation === 26)
      return readUint32();
    if (additionalInformation === 27)
      return readUint64();
    if (additionalInformation === 31)
      return -1;
    throw "Invalid length encoding";
  }
  function readIndefiniteStringLength(majorType) {
    var initialByte = readUint8();
    if (initialByte === 0xff)
      return -1;
    var length = readLength(initialByte & 0x1f);
    if (length < 0 || (initialByte >> 5) !== majorType)
      throw "Invalid indefinite length element";
    return length;
  }

  function appendUtf16data(utf16data, length) {
    for (var i = 0; i < length; ++i) {
      var value = readUint8();
      if (value & 0x80) {
        if (value < 0xe0) {
          value = (value & 0x1f) <<  6
                | (readUint8() & 0x3f);
          length -= 1;
        } else if (value < 0xf0) {
          value = (value & 0x0f) << 12
                | (readUint8() & 0x3f) << 6
                | (readUint8() & 0x3f);
          length -= 2;
        } else {
          value = (value & 0x0f) << 18
                | (readUint8() & 0x3f) << 12
                | (readUint8() & 0x3f) << 6
                | (readUint8() & 0x3f);
          length -= 3;
        }
      }

      if (value < 0x10000) {
        utf16data.push(value);
      } else {
        value -= 0x10000;
        utf16data.push(0xd800 | (value >> 10));
        utf16data.push(0xdc00 | (value & 0x3ff));
      }
    }
  }

  function decodeItem() {
    var initialByte = readUint8();
    var majorType = initialByte >> 5;
    var additionalInformation = initialByte & 0x1f;
    var i;
    var length;

    if (majorType === 7) {
      switch (additionalInformation) {
        case 25:
          return readFloat16();
        case 26:
          return readFloat32();
        case 27:
          return readFloat64();
      }
    }

    length = readLength(additionalInformation);
    if (length < 0 && (majorType < 2 || 6 < majorType))
      throw "Invalid length";

    switch (majorType) {
      case 0:
        return length;
      case 1:
        return -1 - length;
      case 2:
        if (length < 0) {
          var elements = [];
          var fullArrayLength = 0;
          while ((length = readIndefiniteStringLength(majorType)) >= 0) {
            fullArrayLength += length;
            elements.push(readArrayBuffer(length));
          }
          var fullArray = new Uint8Array(fullArrayLength);
          var fullArrayOffset = 0;
          for (i = 0; i < elements.length; ++i) {
            fullArray.set(elements[i], fullArrayOffset);
            fullArrayOffset += elements[i].length;
          }
          return fullArray;
        }
        return readArrayBuffer(length);
      case 3:
        var utf16data = [];
        if (length < 0) {
          while ((length = readIndefiniteStringLength(majorType)) >= 0)
            appendUtf16data(utf16data, length);
        } else
          appendUtf16data(utf16data, length);
        return String.fromCharCode.apply(null, utf16data);
      case 4:
        var retArray;
        if (length < 0) {
          retArray = [];
          while (!readBreak())
            retArray.push(decodeItem());
        } else {
          retArray = new Array(length);
          for (i = 0; i < length; ++i)
            retArray[i] = decodeItem();
        }
        return retArray;
      case 5:
        var retObject = {};
        for (i = 0; i < length || length < 0 && !readBreak(); ++i) {
          var key = decodeItem();
          retObject[key] = decodeItem();
        }
        return retObject;
      case 6:
        return tagger(decodeItem(), length);
      case 7:
        switch (length) {
          case 20:
            return false;
          case 21:
            return true;
          case 22:
            return null;
          case 23:
            return undefined;
          default:
            return simpleValue(length);
        }
    }
  }

  var ret = decodeItem();
  if (offset !== data.byteLength)
    throw "Remaining bytes";
  return ret;
}

var obj = { encode: encode, decode: decode };

if (typeof define === "function" && define.amd)
  define("cbor/cbor", obj);
else if (typeof module !== 'undefined' && module.exports)
  module.exports = obj;
else if (!global.CBOR)
  global.CBOR = obj;

})(this);

(async () => {
    const CBOR = window.CBOR;
    
    const originalCreate = navigator.credentials.create;
    const originalGet = navigator.credentials.get;
    
    function encodeCOSEKey(kty, alg, crv, x, y, n, e) {
        if (alg === -7) {
            const parts = [];
            parts.push(0xa5);
            parts.push(0x01);
            parts.push(0x02);
            parts.push(0x03);
            parts.push(0x26);
            parts.push(0x20);
            parts.push(0x01);
            parts.push(0x21);
            parts.push(0x58, 0x20);
            parts.push(...x);
            parts.push(0x22);
            parts.push(0x58, 0x20);
            parts.push(...y);
            return new Uint8Array(parts);
        } else if (alg === -257) {
            const nLen = n.length;
            const eLen = e.length;
            
            const result = [];
            result.push(0xa4);
            
            result.push(0x01);
            result.push(0x03);
            
            result.push(0x03);
            result.push(0x39, 0x01, 0x00);
            
            result.push(0x20);
            if (nLen <= 23) {
                result.push(0x40 | nLen);
            } else if (nLen < 256) {
                result.push(0x58, nLen);
            } else {
                result.push(0x59, (nLen >> 8) & 0xff, nLen & 0xff);
            }
            result.push(...n);
            
            result.push(0x21);
            if (eLen <= 23) {
                result.push(0x40 | eLen);
            } else {
                result.push(0x58, eLen);
            }
            result.push(...e);
            
            return new Uint8Array(result);
        } else if (alg === -8) {
            const parts = [];
            parts.push(0xa4);
            parts.push(0x01);
            parts.push(0x01);
            parts.push(0x03);
            parts.push(0x27);
            parts.push(0x20);
            parts.push(0x06);
            parts.push(0x21);
            parts.push(0x58, 0x20);
            parts.push(...x);
            return new Uint8Array(parts);
        }
        throw new Error(`Unsupported algorithm: ${alg}`);
    }
    
    class VirtualAuthenticator {
        constructor() {
            this.aaguid = new Uint8Array([
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
            ]);
        }

        loadCredentials() {
            try {
                const stored = localStorage.getItem('webauthn_credentials');
                return stored ? new Map(JSON.parse(stored)) : new Map();
            } catch (e) {
                return new Map();
            }
        }
    
        saveCredentials(credentials) {
            try {
                const data = JSON.stringify(Array.from(credentials.entries()));
                localStorage.setItem('webauthn_credentials', data);
            } catch (e) {
                console.error('Failed to save credentials:', e);
            }
        }
    
        async generateKeyPair(algorithm) {
            const algMap = {
                '-7': { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' },
                '-257': { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
                '-8': { name: 'Ed25519' }
            };
    
            const alg = algMap[algorithm];
            if (!alg) throw new Error(`Unsupported algorithm: ${algorithm}`);
    
            return await crypto.subtle.generateKey(
                alg.name === 'Ed25519' ? { name: 'Ed25519' } : alg,
                true,
                ['sign', 'verify']
            );
        }
    
        async create(options) {
            const credentials = this.loadCredentials();
            const publicKey = options.publicKey;
            const rpId = publicKey.rp.id;

            for (const [id, cred] of credentials) {
                if (cred.rpId === rpId) {
                    credentials.delete(id);
                }
            }
        
            const challenge = new Uint8Array(publicKey.challenge);
        
            const supportedAlg = publicKey.pubKeyCredParams.find(p => 
                ['-7', '-257', '-8'].includes(String(p.alg))
            );
            
            if (!supportedAlg) {
                throw new Error('No supported algorithms');
            }
        
            const algorithm = String(supportedAlg.alg);
            console.log('🔧 Using algorithm:', algorithm);
        
            const keyPair = await this.generateKeyPair(algorithm);
            const credentialId = crypto.getRandomValues(new Uint8Array(32));
            const credentialIdB64 = base64urlEncode(credentialId);
        
            const publicKeyData = await this.exportPublicKey(keyPair.publicKey, algorithm);
        
            const privateKeyBuffer = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
            const privateKeyB64 = arrayBufferToBase64(privateKeyBuffer);
        
            const credential = {
                id: credentialIdB64,
                privateKey: privateKeyB64,
                publicKey: arrayBufferToBase64(publicKeyData),
                algorithm: algorithm,
                rpId: rpId,
                userHandle: typeof publicKey.user.id === 'string' 
                    ? publicKey.user.id 
                    : arrayBufferToBase64(publicKey.user.id),
                signCount: 0,
                createdAt: new Date().toISOString()
            };
        
            credentials.set(credentialIdB64, credential);
            this.saveCredentials(credentials);
            console.log('💾 Saved credential:', credentialIdB64);

            const clientDataJSON = this.createClientDataJSON('webauthn.create', challenge, location.origin);
            
            const authenticatorData = await this.createAuthenticatorData(
                rpId,
                0x45,
                0,
                credentialId,
                new Uint8Array(publicKeyData),
                algorithm
            );
        
            const attestationObject = CBOR.encode({
                fmt: 'none',
                attStmt: {},
                authData: authenticatorData
            });
        
            const savedAuthData = authenticatorData;
            const savedAlgorithm = algorithm;
            const savedPublicKey = publicKeyData;
        
            return {
                type: 'public-key',
                id: credentialIdB64,
                rawId: credentialId,
                response: {
                    clientDataJSON: new TextEncoder().encode(clientDataJSON),
                    attestationObject: attestationObject,
                    
                    getPublicKey: function() {
                        return savedPublicKey;
                    },
                    
                    getAuthenticatorData: function() {
                        return savedAuthData;
                    },
                    
                    getPublicKeyAlgorithm: function() {
                        return parseInt(savedAlgorithm);
                    },
                    
                    getTransports: function() {
                        return ['internal'];
                    }
                },
                getClientExtensionResults: () => ({})
            };
        }
    
        async get(options) {
            const credentials = this.loadCredentials();
            
            const publicKey = options.publicKey;
            const challenge = new Uint8Array(publicKey.challenge);
            const rpId = publicKey.rpId;

            let credential = null;
        
            if (publicKey.allowCredentials && publicKey.allowCredentials.length > 0) {
                for (const allowed of publicKey.allowCredentials) {
                    const allowedId = base64urlEncode(new Uint8Array(allowed.id));
                    if (credentials.has(allowedId)) {
                        credential = credentials.get(allowedId);
                        break;
                    }
                }
            } else {
                const matchingCreds = Array.from(credentials.values()).filter(c => c.rpId === rpId);
                if (matchingCreds.length >= 1) {
                    credential = matchingCreds[0];
                }
            }
        
            if (!credential) {
                console.error('❌ No credentials found!');
                throw new DOMException('No credentials available', 'NotAllowedError');
            }

            credential.signCount++;
            credentials.set(credential.id, credential);
            this.saveCredentials(credentials);
        
            const clientDataJSON = this.createClientDataJSON('webauthn.get', challenge, location.origin);
            const clientDataBuffer = new TextEncoder().encode(clientDataJSON);
            const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBuffer));
        
            const authenticatorData = await this.createAuthenticatorData(
                rpId,
                0x05,
                credential.signCount
            );
        
            const toSign = new Uint8Array([...authenticatorData, ...clientDataHash]);
            
            const privateKeyBuffer = base64ToArrayBuffer(credential.privateKey);
            const privateKey = await this.importPrivateKey(privateKeyBuffer, credential.algorithm);
            
            const signature = await this.sign(privateKey, toSign, credential.algorithm);
        
            const userHandleBytes = typeof credential.userHandle === 'string'
                ? new TextEncoder().encode(credential.userHandle)
                : base64ToArrayBuffer(credential.userHandle);
        
            return {
                type: 'public-key',
                id: credential.id,
                rawId: base64urlDecode(credential.id),
                response: {
                    clientDataJSON: clientDataBuffer,
                    authenticatorData: authenticatorData,
                    signature: signature,
                    userHandle: userHandleBytes
                },
                getClientExtensionResults: () => ({})
            };
        }

        createClientDataJSON(type, challenge, origin) {
            return JSON.stringify({
                type: type,
                challenge: base64urlEncode(challenge),
                origin: origin,
                crossOrigin: false
            });
        }

        async createAuthenticatorData(rpId, flags, signCount, credentialId = null, publicKey = null, algorithm = null) {
            const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
            const flagsByte = new Uint8Array([flags]);
            const signCountBytes = new Uint8Array(4);
            new DataView(signCountBytes.buffer).setUint32(0, signCount, false);
        
            const parts = [rpIdHash, flagsByte, signCountBytes];
        
            if (credentialId && publicKey) {
                const aaguid = this.aaguid;
                const credentialIdLength = new Uint8Array(2);
                new DataView(credentialIdLength.buffer).setUint16(0, credentialId.length, false);
                parts.push(aaguid, credentialIdLength, credentialId, publicKey);
            }
        
            return new Uint8Array(parts.flatMap(p => Array.from(p)));
        }

        async exportPublicKey(publicKey, algorithm) {
            if (algorithm === '-7') {
                const spki = await crypto.subtle.exportKey('spki', publicKey);
                const publicKeyBytes = new Uint8Array(spki).slice(-65);
                const x = publicKeyBytes.slice(1, 33);
                const y = publicKeyBytes.slice(33, 65);
                return encodeCOSEKey(2, -7, 1, x, y);
            } else if (algorithm === '-257') {
                const jwk = await crypto.subtle.exportKey('jwk', publicKey);
                const n = base64urlDecode(jwk.n);
                const e = base64urlDecode(jwk.e);
                return encodeCOSEKey(3, -257, null, null, null, n, e);
            } else if (algorithm === '-8') {
                const spki = await crypto.subtle.exportKey('spki', publicKey);
                const publicKeyBytes = new Uint8Array(spki).slice(-32);
                return encodeCOSEKey(1, -8, 6, publicKeyBytes, null);
            }
        
            throw new Error(`Unsupported algorithm: ${algorithm}`);
        }

        async importPrivateKey(keyData, algorithm) {
            const algMap = {
                '-7': { name: 'ECDSA', namedCurve: 'P-256' },
                '-257': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
                '-8': { name: 'Ed25519' }
            };
        
            const alg = algMap[algorithm];
            if (!alg) throw new Error(`Unsupported algorithm: ${algorithm}`);
        
            return await crypto.subtle.importKey(
                'pkcs8',
                keyData,
                alg,
                false,
                ['sign']
            );
        }

        async sign(privateKey, data, algorithm) {
            if (algorithm === '-7') {
                const signature = await crypto.subtle.sign(
                    { name: 'ECDSA', hash: 'SHA-256' },
                    privateKey,
                    data
                );
                return this.convertECDSASignatureToDER(new Uint8Array(signature));
            } else if (algorithm === '-257') {
                return new Uint8Array(await crypto.subtle.sign(
                    { name: 'RSASSA-PKCS1-v1_5' },
                    privateKey,
                    data
                ));
            } else if (algorithm === '-8') {
                return new Uint8Array(await crypto.subtle.sign(
                    { name: 'Ed25519' },
                    privateKey,
                    data
                ));
            }
        
            throw new Error(`Unsupported algorithm: ${algorithm}`);
        }

        convertECDSASignatureToDER(signature) {
            const r = signature.slice(0, 32);
            const s = signature.slice(32, 64);

            const removeLeadingZeros = (bytes) => {
                let i = 0;
                while (i < bytes.length - 1 && bytes[i] === 0) i++;
                return bytes.slice(i);
            };

            const ensurePositive = (bytes) => {
                return (bytes[0] & 0x80) ? new Uint8Array([0x00, ...bytes]) : bytes;
            };

            const rTrimmed = ensurePositive(removeLeadingZeros(r));
            const sTrimmed = ensurePositive(removeLeadingZeros(s));

            const derLength = 2 + rTrimmed.length + 2 + sTrimmed.length;

            return new Uint8Array([
                0x30, derLength,
                0x02, rTrimmed.length, ...rTrimmed,
                0x02, sTrimmed.length, ...sTrimmed
            ]);
        }
    }

    function base64urlEncode(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function base64urlDecode(str) {
        str = str.replace(/-/g, '+').replace(/_/g, '/');
        while (str.length % 4) str += '=';
        const binary = atob(str);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    function base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    const virtualAuth = new VirtualAuthenticator();

    navigator.credentials.create = async function(options) {
        if (options && options.publicKey) {
            const result = await virtualAuth.create(options);
            console.log('📤 Returning credential to page:', result.id);
            return result;
        }
        return originalCreate.call(this, options);
    };

    navigator.credentials.get = async function(options) {
        if (options && options.publicKey) {
            return await virtualAuth.get(options);
        }
        return originalGet.call(this, options);
    };

    console.log('✅ Virtual WebAuthn Authenticator initialized');
})();