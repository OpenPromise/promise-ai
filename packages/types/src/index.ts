export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCallInfo {
  id: string;
  name: string;
  /** JSON-encoded tool arguments */
  arguments: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  /** Present on assistant messages that requested tool calls */
  toolCalls?: ToolCallInfo[];
  /** Present on tool messages; links to the assistant's tool call */
  toolCallId?: string;
}

export interface Session {
  id: string;
  systemPrompt: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export type DeviceType = 'desktop' | 'web' | 'mobile' | 'car' | 'home' | 'phone';

export interface DeviceInfo {
  deviceId: string;
  deviceType: DeviceType;
  location?: string;
  audioOnly?: boolean;
  screenAvailable?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
