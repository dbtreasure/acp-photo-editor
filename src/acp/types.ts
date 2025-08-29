
export type InitializeParams = {
  protocolVersion: number;
  clientCapabilities?: any;
};
export type InitializeResult = {
  protocolVersion: number;
  agentCapabilities: any;
  authMethods: any[];
};

export type MCPServerConfig = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type SessionNewParams = { 
  cwd: string; 
  mcpServers: MCPServerConfig[];
};
export type SessionNewResult = { sessionId: string };

export type ContentBlockText = { type: 'text'; text: string };

export type ContentBlockImage = {
  type: 'image';
  data: string;      // base64 encoded image
  mimeType: string;  // e.g., 'image/png'
};

export type ContentBlockResourceLink = {
  type: 'resource_link';
  uri: string;            // e.g., file:///…/peppers.jpg
  name?: string;          // optional display name
  mimeType?: string;      // best-effort guess, optional
};

export type ContentBlock = ContentBlockText | ContentBlockImage;
export type PromptContent = ContentBlockText | ContentBlockResourceLink;

export type SessionPromptParams = {
  sessionId: string;
  prompt: PromptContent[];
};

export type SessionPromptResult = {
  stopReason: 'end_turn' | 'cancelled' | string;
};

// Permission request types for Phase 4
export type PermissionOperation = {
  kind: 'write_file';
  uri: string;
  bytesApprox?: number;
};

export type PermissionRequest = {
  title: string;
  explanation: string;
  operations: PermissionOperation[];
};

export type PermissionResponse = {
  approved: boolean;
};

export type ToolCallContent = {
  type: 'content';
  content: ContentBlock;
};

export type ToolCallUpdate = {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  status: 'in_progress' | 'completed' | 'failed';
  rawInput?: any;
  content?: ToolCallContent[];
};

export type SessionUpdateParams = {
  sessionId: string;
} & (
  | {
      sessionUpdate: 'agent_message_chunk';
      content: ContentBlock;
    }
  | ToolCallUpdate
);
