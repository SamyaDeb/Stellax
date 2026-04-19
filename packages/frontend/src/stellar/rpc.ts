/**
 * Singleton Soroban RPC server instance.
 *
 * Re-exported as `rpc` from `@stellar/stellar-sdk` v13+ (not `SorobanRpc`).
 */

import { rpc } from "@stellar/stellar-sdk";
import { config } from "@/config";

let _server: rpc.Server | null = null;

export function getRpcServer(): rpc.Server {
  if (_server === null) {
    _server = new rpc.Server(config.network.rpcUrl, {
      allowHttp: config.network.rpcUrl.startsWith("http://"),
    });
  }
  return _server;
}
