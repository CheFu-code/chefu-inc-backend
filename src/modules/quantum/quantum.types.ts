export type QuantumMessageRole = 'user' | 'assistant';

export type QuantumMessage = {
  id: string;
  role: QuantumMessageRole;
  content: string;
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
