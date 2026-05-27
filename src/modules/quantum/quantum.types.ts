export type QuantumMessageRole = 'user' | 'assistant';

export type QuantumGeneratedImage = {
  id: string;
  mimeType: string;
  data: string;
  alt: string;
};

export type QuantumMessage = {
  id: string;
  role: QuantumMessageRole;
  content: string;
  generatedImages?: QuantumGeneratedImage[];
  timestamp: string;
};

export type QuantumConversation = {
  id: string;
  title: string;
  preview: string;
  timestamp: string;
  starred?: boolean;
  messages: QuantumMessage[];
};

export type ReplaceQuantumConversationsPayload = {
  conversations?: QuantumConversation[];
};
