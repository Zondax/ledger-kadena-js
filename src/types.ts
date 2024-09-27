export interface ResponseAddress {
  pubkey: Buffer;
  address: string;
}

export interface ResponseSign {
  signature: Buffer;
}

// Using the same structures as in the legacy code
export interface BuildTransactionResult {
  pubkey: string;
  pact_command: PactCommandObject;
}

export interface PactCommandObject {
  cmd: string;
  hash: string;
  sigs: PactCommandSig[];
}

export interface PactCommandSig {
  sig: string;
}

export enum TransferTxType {
  TRANSFER = 0,
  TRANSFER_CREATE = 1,
  TRANSFER_CROSS_CHAIN = 2,
}
export interface TransferTxParams {
  path?: string;
  namespace?: string;
  module?: string;
  recipient: string;
  amount: string;
  chainId: number;
  network: string;
  gasPrice?: string;
  gasLimit?: string;
  creationTime?: number;
  ttl?: string;
  nonce?: string;
}

export interface TransferCrossChainTxParams extends TransferTxParams {
  recipient_chainId: number;
}

export const maxLengths = {
  recipient: 64,
  namespace: 16,
  module: 32,
  recipient_chainId: 2,
  network: 20,
  amount: 32,
  gasPrice: 20,
  gasLimit: 10,
  creationTime: 12,
  chainId: 2,
  nonce: 32,
  ttl: 20,
};
