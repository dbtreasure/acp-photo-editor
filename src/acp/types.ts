
export type InitializeParams = {
  protocolVersion: number;
  clientCapabilities?: any;
};
export type InitializeResult = {
  protocolVersion: number;
  agentCapabilities: any;
  authMethods: any[];
};

export type SessionNewParams = { cwd: string; mcpServers: any[] };
export type SessionNewResult = { sessionId: string };

export type ContentBlockText = { type: 'text'; text: string };

export type SessionPromptParams = {
  sessionId: string;
  prompt: ContentBlockText[];
};

export type SessionPromptResult = {
  stopReason: 'end_turn' | 'cancelled' | string;
};

export type SessionUpdateParams = {
  sessionId: string;
  sessionUpdate: 'agent_message_chunk';
  content: ContentBlockText;
};
