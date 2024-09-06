/** ******************************************************************************
 *  (c) 2019-2024 Zondax AG
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 ******************************************************************************* */
import type Transport from "@ledgerhq/hw-transport";
import BaseApp, {
  BIP32Path,
  INSGeneric,
  processErrorResponse,
  processResponse,
} from "@zondax/ledger-js";

import {
  ResponseAddress,
  ResponseSign,
  ResponseSignTransfer,
  TransferTxParams,
  TransferCrossChainTxParams,
  TransferTxType,
  maxLengths,
} from "./types";
import { P1_VALUES, PUBKEYLEN } from "./consts";
import { blake2bFinal, blake2bInit, blake2bUpdate } from "blakejs";

export class KadenaApp extends BaseApp {
  static _INS = {
    GET_VERSION: 0x20 as number,
    GET_ADDR: 0x21 as number,
    SIGN: 0x22 as number,
    SIGN_HASH: 0x23 as number,
    SIGN_TRANSFER_TX: 0x24 as number,
  };

  static _params = {
    cla: 0x00,
    ins: { ...KadenaApp._INS } as INSGeneric,
    p1Values: { ONLY_RETRIEVE: 0x00 as 0, SHOW_ADDRESS_IN_DEVICE: 0x01 as 1 },
    chunkSize: 250,
    requiredPathLengths: [5],
  };

  constructor(transport: Transport) {
    super(transport, KadenaApp._params);
    if (!this.transport) {
      throw new Error("Transport has not been defined");
    }
  }

  async getAddressAndPubKey(
    bip44Path: BIP32Path,
    showAddrInDevice = false,
  ): Promise<ResponseAddress> {
    const bip44PathBuffer = this.serializePath(bip44Path);
    const p1 = showAddrInDevice
      ? P1_VALUES.SHOW_ADDRESS_IN_DEVICE
      : P1_VALUES.ONLY_RETRIEVE;

    try {
      const responseBuffer = await this.transport.send(
        this.CLA,
        this.INS.GET_ADDR,
        p1,
        0,
        bip44PathBuffer,
      );

      const response = processResponse(responseBuffer);
      const pubkey = response.readBytes(PUBKEYLEN);
      const address = response.readBytes(response.length()).toString();

      return {
        pubkey,
        address,
      } as ResponseAddress;
    } catch (e) {
      throw processErrorResponse(e);
    }
  }

  async sign(path: BIP32Path, blob: Buffer): Promise<ResponseSign> {
    const chunks = this.prepareChunks(path, blob);
    try {
      let signatureResponse = await this.signSendChunk(
        this.INS.SIGN,
        1,
        chunks.length,
        chunks[0],
      );

      for (let i = 1; i < chunks.length; i += 1) {
        signatureResponse = await this.signSendChunk(
          this.INS.SIGN,
          1 + i,
          chunks.length,
          chunks[i],
        );
      }
      return {
        signature: signatureResponse.readBytes(signatureResponse.length()),
      };
    } catch (e) {
      throw processErrorResponse(e);
    }
  }

  async signHash(
    path: BIP32Path,
    hash: string | Buffer | Uint8Array,
  ): Promise<ResponseSign> {
    const rawHash =
      typeof hash == "string"
        ? hash.length == 64
          ? Buffer.from(hash, "hex")
          : Buffer.from(hash, "base64")
        : Buffer.from(hash);
    if (rawHash.length != 32) {
      throw new TypeError("Hash is not 32 bytes");
    } else {
      const chunks = this.prepareChunks(path, rawHash);
      try {
        let signatureResponse = await this.signSendChunk(
          this.INS.SIGN_HASH,
          1,
          chunks.length,
          chunks[0],
        );

        for (let i = 1; i < chunks.length; i += 1) {
          signatureResponse = await this.signSendChunk(
            this.INS.SIGN_HASH,
            1 + i,
            chunks.length,
            chunks[i],
          );
        }
        return {
          signature: signatureResponse.readBytes(signatureResponse.length()),
        };
      } catch (e) {
        throw processErrorResponse(e);
      }
    }
  }

  async signTransferTx(
    path: BIP32Path,
    params: TransferTxParams,
  ): Promise<ResponseSignTransfer> {
    var p1 = params as TransferCrossChainTxParams;
    p1.recipient_chainId = 0; // Ignored by Ledger App
    return await this.signTxInternal(path, p1, TransferTxType.TRANSFER);
  }

  async signTransferCreateTx(
    path: BIP32Path,
    params: TransferTxParams,
  ): Promise<ResponseSignTransfer> {
    var p1 = params as TransferCrossChainTxParams;
    p1.recipient_chainId = 0; // Ignored by Ledger App
    return await this.signTxInternal(path, p1, TransferTxType.TRANSFER_CREATE);
  }

  async signTransferCrossChainTx(
    path: BIP32Path,
    params: TransferCrossChainTxParams,
  ): Promise<ResponseSignTransfer> {
    if (params.chainId == params.recipient_chainId)
      throw new TypeError(
        "Recipient chainId is same as sender's in a cross-chain transfer",
      );
    return await this.signTxInternal(
      path,
      params,
      TransferTxType.TRANSFER_CROSS_CHAIN,
    );
  }

  private async signTxInternal(
    path: BIP32Path,
    params: TransferCrossChainTxParams,
    txType: TransferTxType,
  ): Promise<ResponseSignTransfer> {
    // Use defaults if value not specified
    const t: Date = new Date();

    this.checkTransferTxParamsSanity(params);

    const recipient = params.recipient.startsWith("k:")
      ? params.recipient.substring(2)
      : params.recipient;
    const namespace_ = params.namespace === undefined ? "" : params.namespace;
    const module_ = params.module === undefined ? "" : params.module;
    const amount = convertDecimal(params.amount);
    const gasPrice = params.gasPrice === undefined ? "1.0e-6" : params.gasPrice;
    const gasLimit = params.gasLimit === undefined ? "2300" : params.gasLimit;
    const creationTime =
      params.creationTime === undefined
        ? Math.floor(t.getTime() / 1000)
        : params.creationTime;
    const ttl = params.ttl === undefined ? "600" : params.ttl;
    const nonce = params.nonce === undefined ? "" : params.nonce;

    const txTypeB = Buffer.alloc(1);
    txTypeB.writeInt8(txType);
    // These are just squashed together
    const payload = Buffer.concat([
      txTypeB,
      textPayload(recipient),
      textPayload(params.recipient_chainId.toString()),
      textPayload(params.network),
      textPayload(amount),
      textPayload(namespace_),
      textPayload(module_),
      textPayload(gasPrice),
      textPayload(gasLimit),
      textPayload(creationTime.toString()),
      textPayload(params.chainId.toString()),
      textPayload(nonce),
      textPayload(ttl),
    ]);

    const chunks = this.prepareChunks(path, payload);
    try {
      let signatureResponse = await this.signSendChunk(
        this.INS.SIGN_TRANSFER_TX,
        1,
        chunks.length,
        chunks[0],
      );

      for (let i = 1; i < chunks.length; i += 1) {
        signatureResponse = await this.signSendChunk(
          this.INS.SIGN_TRANSFER_TX,
          1 + i,
          chunks.length,
          chunks[i],
        );
      }

      const pubkey = await this.getAddressAndPubKey(path, false);
      const json = this.buildTransferJson(
        params,
        txType,
        pubkey.pubkey.toString("hex"),
        creationTime,
      );

      const context = blake2bInit(32);
      const jsonBuff = Buffer.from(json);
      blake2bUpdate(context, jsonBuff);
      const hash_bytes = Buffer.from(blake2bFinal(context));

      var hash = Buffer.from(hash_bytes)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");

      return {
        signature: signatureResponse.readBytes(signatureResponse.length()),
        cmd: json,
        hash: hash,
      };
    } catch (e) {
      throw processErrorResponse(e);
    }
  }

  private checkTransferTxParamsSanity(
    params: TransferCrossChainTxParams,
  ): void {
    const recipient = params.recipient.startsWith("k:")
      ? params.recipient.substring(2)
      : params.recipient;
    if (!recipient.match(/[0-9A-Fa-f]{64}/g))
      throw new TypeError(
        "Recipient should be a hex encoded pubkey or 'k:' address",
      );

    const namespace_ = params.namespace === undefined ? "" : params.namespace;
    const module_ = params.module === undefined ? "" : params.module;
    if (namespace_ != "" && module_ == "")
      throw new TypeError(
        "Along with 'namespace' 'module' need to be specified",
      );

    let isNaN_ = (v: unknown) => {
      if (v === undefined) return false;
      return isNaN(v as unknown as number);
    };
    if (isNaN_(params.amount)) throw new TypeError("amount is non a number");
    if (isNaN_(params.gasPrice))
      throw new TypeError("gasPrice is non a number");
    if (isNaN_(params.gasLimit))
      throw new TypeError("gasLimit is non a number");
    if (isNaN_(params.creationTime))
      throw new TypeError("creationTime is non a number");
    if (isNaN_(params.ttl)) throw new TypeError("ttl is non a number");

    for (const [key, maxLength] of Object.entries(maxLengths)) {
      const value =
        key === "recipient" ? recipient : params[key as keyof typeof params];
      const strValue = (value || "").toString();

      if (key === "recipient" && strValue.length !== maxLength) {
        throw new TypeError(
          `${key} should be exactly ${maxLength} characters long`,
        );
      } else if (strValue.length > maxLength) {
        throw new TypeError(`${key} should be ${maxLength} characters or less`);
      }
    }
  }

  private buildTransferJson(
    params: TransferCrossChainTxParams,
    txType: number,
    pubkey: string,
    creationTime: number,
  ): string {
    // Build the JSON, exactly like the Ledger app
    const recipient = params.recipient.startsWith("k:")
      ? params.recipient.substring(2)
      : params.recipient;
    const namespace_ = params.namespace === undefined ? "" : params.namespace;
    const module_ = params.module === undefined ? "" : params.module;

    var cmd = '{"networkId":"' + params.network + '"';
    if (txType == 0) {
      cmd += ',"payload":{"exec":{"data":{},"code":"';
      if (namespace_ == "") {
        cmd += "(coin.transfer";
      } else {
        cmd += "(" + namespace_ + "." + module_ + ".transfer";
      }
      cmd += ' \\"k:' + pubkey + '\\"';
      cmd += ' \\"k:' + recipient + '\\"';
      cmd += " " + params.amount + ')"}}';
      cmd += ',"signers":[{"pubKey":"' + pubkey + '"';
      cmd +=
        ',"clist":[{"args":["k:' +
        pubkey +
        '","k:' +
        recipient +
        '",' +
        params.amount +
        "]";
      if (namespace_ == "") {
        cmd += ',"name":"coin.TRANSFER"},{"args":[],"name":"coin.GAS"}]}]';
      } else {
        cmd +=
          ',"name":"' +
          namespace_ +
          "." +
          module_ +
          '.TRANSFER"},{"args":[],"name":"coin.GAS"}]}]';
      }
    } else if (txType == 1) {
      cmd += ',"payload":{"exec":{"data":{';
      cmd += '"ks":{"pred":"keys-all","keys":["' + recipient + '"]}';
      cmd += '},"code":"';
      if (namespace_ == "") {
        cmd += "(coin.transfer-create";
      } else {
        cmd += "(" + namespace_ + "." + module_ + ".transfer-create";
      }
      cmd += ' \\"k:' + pubkey + '\\"';
      cmd += ' \\"k:' + recipient + '\\"';
      cmd += ' (read-keyset \\"ks\\")';
      cmd += " " + params.amount + ')"}}';
      cmd += ',"signers":[{"pubKey":"' + pubkey + '"';
      cmd +=
        ',"clist":[{"args":["k:' +
        pubkey +
        '","k:' +
        recipient +
        '",' +
        params.amount +
        "]";
      if (namespace_ == "") {
        cmd += ',"name":"coin.TRANSFER"},{"args":[],"name":"coin.GAS"}]}]';
      } else {
        cmd +=
          ',"name":"' +
          namespace_ +
          "." +
          module_ +
          '.TRANSFER"},{"args":[],"name":"coin.GAS"}]}]';
      }
    } else {
      cmd += ',"payload":{"exec":{"data":{';
      cmd += '"ks":{"pred":"keys-all","keys":["' + recipient + '"]}';
      cmd += '},"code":"';
      if (namespace_ == "") {
        cmd += "(coin.transfer-crosschain";
      } else {
        cmd += "(" + namespace_ + "." + module_ + ".transfer-crosschain";
      }
      cmd += ' \\"k:' + pubkey + '\\"';
      cmd += ' \\"k:' + recipient + '\\"';
      cmd += ' (read-keyset \\"ks\\")';
      cmd += ' \\"' + params.recipient_chainId.toString() + '\\"';
      cmd += " " + params.amount + ')"}}';
      cmd += ',"signers":[{"pubKey":"' + pubkey + '"';
      cmd +=
        ',"clist":[{"args":["k:' +
        pubkey +
        '","k:' +
        recipient +
        '",' +
        params.amount +
        ',"' +
        params.recipient_chainId.toString() +
        '"]';
      if (namespace_ == "") {
        cmd +=
          ',"name":"coin.TRANSFER_XCHAIN"},{"args":[],"name":"coin.GAS"}]}]';
      } else {
        cmd +=
          ',"name":"' +
          namespace_ +
          "." +
          module_ +
          '.TRANSFER_XCHAIN"},{"args":[],"name":"coin.GAS"}]}]';
      }
    }
    cmd += ',"meta":{"creationTime":' + creationTime.toString();
    cmd +=
      ',"ttl":' +
      params.ttl +
      ',"gasLimit":' +
      params.gasLimit +
      ',"chainId":"' +
      params.chainId.toString() +
      '"';
    cmd +=
      ',"gasPrice":' +
      params.gasPrice +
      ',"sender":"k:' +
      pubkey +
      '"},"nonce":"' +
      params.nonce +
      '"}';

    return cmd;
  }
}

function textPayload(txt: string): Buffer {
  // 1 byte: length
  const payload = Buffer.alloc(1 + txt.length);
  payload[0] = txt.length;
  payload.write(txt, 1, "utf-8");
  return payload;
}

const convertDecimal = (decimal: number | string): string => {
  const decimalStr = decimal.toString();
  if (decimalStr.includes(".")) {
    return decimalStr;
  }
  const numValue = Number(decimalStr);
  if (Number.isInteger(numValue)) {
    return `${decimalStr}.0`;
  }
  return decimalStr;
};
