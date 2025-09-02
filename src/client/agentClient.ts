import { spawn, ChildProcess } from 'child_process';
import { JsonRpcPeer } from '../common/jsonrpc';
import { NdjsonLogger } from '../common/logger';

export interface AgentClientOptions {
  agentCmd: string;
  agentArgs?: string[];
  logger: NdjsonLogger;
}

export interface AgentClient {
  child: ChildProcess;
  peer: JsonRpcPeer;
}

export function spawnAgentClient(options: AgentClientOptions): AgentClient {
  const { agentCmd, agentArgs = [], logger } = options;
  const child = spawn(agentCmd, agentArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
  const peer = new JsonRpcPeer(child.stdout, child.stdin, logger);
  return { child, peer };
}
